import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { DisputeArbitrationQueueService } from "../services/disputeArbitrationQueue.js";
import {
  appendFinalityLink,
  canTransition,
  decideByMajority,
  getSeniorPool,
  isWithinAppealWindow,
  resetSeniorPool,
  selectSeniorPanel,
  validateSeniorDecision,
  SENIOR_PANEL_MIN_SIZE,
} from "../services/disputeAppeals.js";
import { reverseAutoResolve, scanAndAutoResolve } from "../services/disputeDeadlineService.js";
import { isDisputeDeadlineSchedulerRunning } from "../scheduler/disputeDeadlineScheduler.js";
import type { Dispute as DisputeDomainType, SeniorPanelVote } from "../types/dispute.js";
import { AUDIT_SCHEMA_VERSION } from "../types/auditEvent.js";

const router = Router();

const disputeQueueService = new DisputeArbitrationQueueService();

// In-memory dispute state for E2E tests
const disputes = new Map<string, DisputeDomainType>();
let ledgers = { buyer: 1000, supplier: 1000 };


/**
 * Export a snapshot of the current dispute list. Used by the dispute deadline
 * scheduler in `src/index.ts` and by tests via `resetDisputesState`.
 */
export function getDisputes(): DisputeDomainType[] {
  return Array.from(disputes.values());
}

export const resetDisputesState = () => {
  disputes.clear();
  ledgers = { buyer: 1000, supplier: 1000 };
  resetSeniorPool();
  disputeQueueService.clear();
};

function readStringField(body: any, key: string, fallback: unknown): string {
  if (!body || typeof body !== "object") {
    return String(fallback ?? "");
  }
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : String(fallback ?? "");
}

function readNumber(body: any, key: string, fallback: number): number {
  if (!body || typeof body !== "object") return fallback;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

async function logAudit(
  action: string,
  body: Record<string, unknown>,
  options: { status: number | string; resource: string },
): Promise<void> {
  try {
    const auditLogger = (globalThis as typeof globalThis & { defaultAuditLogger?: typeof defaultAuditLogger }).defaultAuditLogger ?? defaultAuditLogger;
    await auditLogger.log(
      action,
      {
        method: "POST",
        body,
        context: { schemaVersion: AUDIT_SCHEMA_VERSION },
      },
      options,
    );
  } catch {
    // Audit-write failures must not block dispute transitions; the
    // logger already console-errors internally before it throws.
  }
}

function newDisputeId(): string {
  return `dispute-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

router.post("/disputes", requireAdminToken, (req, res) => {
  const body = req.body ?? {};
  const buyerId = readStringField(body, "buyerId", "");
  const supplierId = readStringField(body, "supplierId", "");
  const amount = readNumber(body, "amount", 0);
  // Optional per-dispute appeal window (ms). Used for tests that
  // simulate a fast-expiring window; production callers usually let
  // the default 72 h stand and let the runtime enforce it.
  const parsedWindow = Number(body?.appealWindowMs);
  const appealWindowMs =
    Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : undefined;
  const id = newDisputeId();
  const dispute: DisputeDomainType = {
    id,
    status: "OPEN",
    buyerId,
    supplierId,
    // Default the buyer/supplier's tenantId to their id so tests and
    // callers that don't supply real tenant affiliations still satisfy
    // the COI checks. Production callers SHOULD pass explicit values.
    buyerTenantId: readStringField(body, "buyerTenantId", buyerId),
    supplierTenantId: readStringField(body, "supplierTenantId", supplierId),
    amount,
    evidence: [],
    finalityHash: null,
    finalityChain: [],
    appealWindowMs,
  };
  disputes.set(id, dispute);
  const buyerTier = (typeof body.buyerTier === "string" && ["bronze", "silver", "gold", "platinum"].includes(body.buyerTier)
    ? body.buyerTier
    : "bronze") as import("../services/disputeArbitrationQueue.js").BuyerTier;
  disputeQueueService.enqueueDispute({
    disputeId: id,
    amount,
    buyerTier,
    createdAt: Date.now(),
    queuedAt: Date.now(),
  });
  return res.status(201).json({ success: true, dispute });
});

router.post("/disputes/:id/evidence", requireAdminToken, (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });
  if (req.body?.failUpload) return res.status(500).json({ success: false, error: "Evidence upload failed" });

  if (!canTransition(dispute.status, "EVIDENCED")) {
    return res.status(409).json({
      success: false,
      code: "INVALID_STATE_TRANSITION",
      error: `Cannot add evidence in state ${dispute.status}`,
    });
  }

  dispute.evidence.push(req.body.evidence);
  const at = Date.now();
  const link = appendFinalityLink(
    dispute,
    "EVIDENCED",
    { evidenceCount: dispute.evidence.length },
    at,
  );
  dispute.status = "EVIDENCED";
  dispute.finalityHash = link.hash;
  dispute.finalityChain.push(link);

  return res.status(200).json({
    success: true,
    dispute,
    evidenceAnchor: `anchor-${at}`,
  });
});

router.post("/disputes/:id/adjudicate", requireAdminToken, (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });

  const { ruling, arbiter } = req.body ?? {};
  if (!canTransition(dispute.status, "ADJUDICATED")) {
    return res.status(409).json({
      success: false,
      code: "INVALID_STATE_TRANSITION",
      error: `Cannot adjudicate in state ${dispute.status}`,
    });
  }

  dispute.ruling = ruling;
  dispute.arbiter = arbiter;
  dispute.adjudicatedAt = Date.now();
  const at = dispute.adjudicatedAt;
  const link = appendFinalityLink(
    dispute,
    "ADJUDICATED",
    { ruling: String(ruling), arbiter: String(arbiter) },
    at,
  );
  dispute.status = "ADJUDICATED";
  dispute.finalityHash = link.hash;
  dispute.finalityChain.push(link);
  disputeQueueService.removeDispute(req.params.id);

  if (ruling === "BUYER_FAVOR") {
    ledgers.buyer += dispute.amount;
    ledgers.supplier -= dispute.amount;
  } else {
    ledgers.buyer -= dispute.amount;
    ledgers.supplier += dispute.amount;
  }

  return res.status(200).json({
    success: true,
    dispute,
    rulingAudit: `audit-${at}`,
    ledgers,
  });
});

router.get("/disputes/queue", requireAdminToken, (req, res) => {
  const now = Date.now();
  const queue = disputeQueueService.list(now);
  return res.status(200).json({
    success: true,
    queue,
  });
});

router.get("/disputes/queue/dashboard", requireAdminToken, (req, res) => {
  const now = Date.now();
  return res.status(200).json({
    success: true,
    dashboard: disputeQueueService.getDashboard(now),
  });
});

router.post("/disputes/:id/appeal", requireAdminToken, async (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });

  const now = Date.now();
  const resource = req.originalUrl;

  // Reject any state that isn't ADJUDICATED first — including appeal-of-
  // appeal (APPEALED, SENIOR_REVIEW, FINAL) and terminal states
  // (CLOSED, TIMEOUT). This is the "block appeal-of-appeal" requirement.
  if (dispute.status !== "ADJUDICATED") {
    const reason =
      dispute.status === "APPEALED" || dispute.status === "SENIOR_REVIEW"
        ? "APPEAL_OF_APPEAL"
        : "INVALID_STATE";
    await logAudit(
      "DISPUTE_APPEAL_REJECTED",
      { disputeId: dispute.id, reason, currentStatus: dispute.status },
      { status: "rejected", resource },
    );
    const httpStatus = reason === "APPEAL_OF_APPEAL" ? 409 : 409;
    return res.status(httpStatus).json({
      success: false,
      code: reason === "APPEAL_OF_APPEAL" ? "APPEAL_OF_APPEAL" : "INVALID_STATE_TRANSITION",
      error: `Cannot appeal from state ${dispute.status}`,
    });
  }

  if (!isWithinAppealWindow(dispute, now)) {
    await logAudit(
      "DISPUTE_APPEAL_REJECTED",
      { disputeId: dispute.id, reason: "WINDOW_EXPIRED" },
      { status: "rejected", resource },
    );
    return res.status(410).json({
      success: false,
      code: "APPEAL_WINDOW_EXPIRED",
      error: "Appeal window has closed for this dispute",
    });
  }

  // Select senior panel BEFORE mutating state so a 503 (insufficient
  // pool) can be returned without rolling back an otherwise-acceptable
  // appeal.
  const selection = selectSeniorPanel(getSeniorPool(), dispute);
  if (selection.panel.length < SENIOR_PANEL_MIN_SIZE) {
    await logAudit(
      "DISPUTE_APPEAL_REJECTED",
      {
        disputeId: dispute.id,
        reason: "INSUFFICIENT_SENIOR_POOL",
        excluded: selection.excluded,
      },
      { status: "rejected", resource },
    );
    return res.status(503).json({
      success: false,
      code: "INSUFFICIENT_SENIOR_POOL",
      error: `At least ${SENIOR_PANEL_MIN_SIZE} eligible senior arbiters required; found ${selection.panel.length}`,
    });
  }

  // Audit-first: announce the intent before state mutation.
  await logAudit(
    "DISPUTE_APPEAL_INITIATED",
    {
      disputeId: dispute.id,
      panel: selection.panel.map((p) => p.id),
    },
    { status: "attempted", resource },
  );

  // ADJUDICATED → APPEALED
  const appealedAt = now;
  const appealedLink = appendFinalityLink(
    dispute,
    "APPEALED",
    {
      actor: req.ip || "admin",
      panel: selection.panel.map((p) => p.id),
    },
    appealedAt,
  );
  dispute.status = "APPEALED";
  dispute.finalityHash = appealedLink.hash;
  dispute.finalityChain.push(appealedLink);
  dispute.appealInitiatedAt = appealedAt;
  dispute.panel = selection.panel;

  // APPEALED → SENIOR_REVIEW happens atomically since the panel was just
  // selected; the dispute is now waiting on panel votes.
  const seniorAt = now;
  const seniorLink = appendFinalityLink(
    dispute,
    "SENIOR_REVIEW",
    { panel: selection.panel.map((p) => p.id) },
    seniorAt,
  );
  dispute.status = "SENIOR_REVIEW";
  dispute.finalityHash = seniorLink.hash;
  dispute.finalityChain.push(seniorLink);

  await logAudit(
    "DISPUTE_SENIOR_PANEL_SELECTED",
    { disputeId: dispute.id, panel: selection.panel.map((p) => p.id) },
    { status: 200, resource },
  );

  return res.status(200).json({
    success: true,
    dispute,
    panel: selection.panel,
  });
});

router.post("/disputes/:id/senior-decide", requireAdminToken, async (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });

  const resource = req.originalUrl;
  const votes = Array.isArray(req.body?.votes) ? (req.body.votes as SeniorPanelVote[]) : [];
  const validation = validateSeniorDecision(dispute, { votes });
  if (validation) {
    await logAudit(
      "DISPUTE_FINAL_REJECTED",
      { disputeId: dispute.id, reason: validation.code, message: validation.message },
      { status: "rejected", resource },
    );
    return res.status(400).json({
      success: false,
      code: validation.code,
      error: validation.message,
    });
  }

  const outcome = decideByMajority(votes);
  const at = Date.now();
  const link = appendFinalityLink(
    dispute,
    "FINAL",
    {
      outcome,
      votes: votes.map((v: SeniorPanelVote) => ({ arbiterId: v.arbiterId, vote: v.vote })),
    },
    at,
  );
  dispute.status = "FINAL";
  dispute.finalityHash = link.hash;
  dispute.finalityChain.push(link);
  dispute.panelVotes = votes;
  dispute.seniorDecisionAt = at;
  dispute.finalRuling = outcome === "UPHOLD" ? "UPHELD" : "OVERTURNED";

  // Reverse the original ledger movement if the panel overturned the
  // initial ruling — the senior panel is the final authority.
  if (outcome === "OVERTURN" && dispute.ruling) {
    if (dispute.ruling === "BUYER_FAVOR") {
      ledgers.buyer -= dispute.amount;
      ledgers.supplier += dispute.amount;
    } else {
      ledgers.buyer += dispute.amount;
      ledgers.supplier -= dispute.amount;
    }
  }

  await logAudit(
    "DISPUTE_FINAL",
    {
      disputeId: dispute.id,
      outcome,
      panel: dispute.panel?.map((p) => p.id) ?? [],
    },
    { status: 200, resource },
  );

  return res.status(200).json({ success: true, dispute, ledgers });
});

router.get("/disputes/:id/finality", requireAdminToken, (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });
  return res.status(200).json({
    success: true,
    disputeId: dispute.id,
    finalityHash: dispute.finalityHash,
    chain: dispute.finalityChain.map((c) => ({ ...c })),
  });
});

router.post("/disputes/:id/timeout", requireAdminToken, (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });

  if (!canTransition(dispute.status, "TIMEOUT")) {
    return res.status(409).json({
      success: false,
      code: "INVALID_STATE_TRANSITION",
      error: `Cannot timeout in state ${dispute.status}`,
    });
  }

  const at = Date.now();
  const link = appendFinalityLink(dispute, "TIMEOUT", {}, at);
  dispute.status = "TIMEOUT";
  dispute.finalityHash = link.hash;
  dispute.finalityChain.push(link);
  disputeQueueService.removeDispute(req.params.id);

  return res.status(200).json({ success: true, dispute });
});
// ----------------------------------------

/**
 * @route POST /api/v1/admin/disputes/deadline/scan
 * @desc Trigger a one-off scan of stale disputes for auto-resolution.
 *   Returns the list of disputes that were auto-resolved during this scan.
 * @access Private (admin token only)
 */
router.post("/disputes/deadline/scan", requireAdminToken, (_req: Request, res: Response) => {
  try {
    const allDisputes = Array.from(disputes.values()) as DisputeDomainType[];
    // Support configurable windows via query params for testing
    const now = Date.now();
    const result = scanAndAutoResolve(allDisputes, {
      now: () => now,
    });
    return res.status(200).json({
      success: true,
      resolved: result.resolved,
      skipped: result.skipped,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message ?? "Deadline scan failed",
    });
  }
});

/**
 * @route POST /api/v1/admin/disputes/:id/reverse-auto-resolve
 * @desc Reverse an auto-resolution within the reversal window.
 *   The dispute is restored to the status it held before auto-resolution.
 * @access Private (admin token only)
 */
router.post("/disputes/:id/reverse-auto-resolve", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const result = reverseAutoResolve(
      disputes,
      req.params.id,
    );

    if (!result.reversed) {
      const statusMap: Record<string, number> = {
        DISPUTE_NOT_FOUND: 404,
        NOT_AUTO_RESOLVED: 400,
        REVERSAL_WINDOW_EXPIRED: 410,
        INVALID_STATE: 409,
      };
      const httpStatus = result.error ? (statusMap[result.error.code] ?? 400) : 400;
      return res.status(httpStatus).json({
        success: false,
        error: result.error?.message ?? "Reversal failed",
        code: result.error?.code,
      });
    }

    return res.status(200).json({
      success: true,
      dispute: result.dispute,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message ?? "Reversal failed",
    });
  }
});

/**
 * @route GET /api/v1/admin/disputes/deadline/status
 * @desc Check whether the dispute deadline scheduler is running.
 * @access Private (admin token only)
 */
router.get("/disputes/deadline/status", requireAdminToken, (_req: Request, res: Response) => {
  return res.status(200).json({
    success: true,
    running: isDisputeDeadlineSchedulerRunning(),
  });
});

export default router;
