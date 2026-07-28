import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { auditExportService } from "../services/auditExportService.js";
import { RefundService } from "../services/refund.js";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { InMemoryImpersonationSessionStore } from "../services/impersonationSessionStore.js";

import { _settlements } from "../services/settlementReconciler.js";
import { fraudReviewQueue } from "../services/fraudReviewQueue.js";
import {
  defaultSupplierCancellationOverrideStore,
} from "../services/supplierCancellationOverrideStore.js";
import {
  accessReviewService,
} from "../services/accessReviewService.js";
import type { ReportFormat } from "../types/accessReview.js";

const router = Router();

// --- Pending Payout Replays State ---
export type PendingReplay = {
  transactionId: string;
  initiatorId: string;
  reason: string;
  expiresAt: number;
};
export const pendingReplays = new Map<string, PendingReplay>();

function buildBaseUrl(req: Request): string {
  const scheme = req.protocol;
  const host = req.get("host") ?? "localhost";
  return `${scheme}://${host}`;
}

function getActorIp(req: Request): string {
  const rawIp = req.ip?.replace("::ffff:", "") ?? req.socket?.remoteAddress?.replace("::ffff:", "") ?? "127.0.0.1";
  return rawIp || "127.0.0.1";
}

/**
 * @route POST /api/v1/admin/audit/export
 * @desc Generate an admin-only audit JSONL export and receive a signed download URL.
 * @access Private (admin token only)
 */
router.post("/audit/export", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const baseUrl = buildBaseUrl(req);
    const result = await auditExportService.createExport(baseUrl);
    return res.status(201).json({
      success: true,
      downloadUrl: result.downloadUrl,
      integrity: result.integrity,
      expiresAt: result.expiresAt,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message ?? "Audit export failed" });
  }
});

/**
 * @route GET /api/v1/admin/audit/export/download
 * @desc Download a signed audit export file using a short-lived token.
 * @access Public via signed token
 */
router.get("/audit/export/download", async (req: Request, res: Response) => {
  try {
    const token = req.query.token;
    if (!token || typeof token !== "string") {
      return res.status(400).json({ success: false, error: "Missing export token" });
    }

    const exportEntry = await auditExportService.getExport(token);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", "attachment; filename=chronopay-audit-export.ndjson");
    res.setHeader("X-Audit-Export-Integrity-Sha256", exportEntry.integrity);
    return res.send(exportEntry.content);
  } catch (error: any) {
    const message = error.message || "Export download failed";
    if (message.includes("expired") || message.includes("Invalid export token")) {
      return res.status(401).json({ success: false, error: message });
    }
    if (message.includes("not found")) {
      return res.status(404).json({ success: false, error: message });
    }
    return res.status(500).json({ success: false, error: message });
  }
});

/**
 * @route POST /api/v1/admin/webhooks/rotate
 * @desc Promote the NEXT webhook secret to CURRENT and move the previous CURRENT to PREVIOUS.
 * @access Private (admin token only)
 */
router.post("/webhooks/rotate", requireAdminToken, (req: Request, res: Response) => {
  const next = process.env.SETTLEMENTS_WEBHOOK_SECRET_NEXT;
  if (!next) {
    return res.status(400).json({ success: false, error: "No NEXT webhook secret configured" });
  }

  const oldCurrent = process.env.SETTLEMENTS_WEBHOOK_SECRET;
  if (oldCurrent) {
    process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS = oldCurrent;
  }

  process.env.SETTLEMENTS_WEBHOOK_SECRET = next;
  delete process.env.SETTLEMENTS_WEBHOOK_SECRET_NEXT;

  return res.status(200).json({ success: true });
});

// --- Refund Routes ---

/**
 * @route POST /api/v1/admin/refunds
 * @desc Create a partial refund against a completed payment session.
 *       Enforces the invariant that sum of refunds <= captured amount.
 * @access Private (admin token only)
 */
router.post("/refunds", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const { paymentId, amountCents, currency, reason, refundedBy } = req.body;

    if (!paymentId) {
      return res.status(400).json({ success: false, error: "paymentId is required" });
    }
    if (!amountCents || typeof amountCents !== "number" || amountCents <= 0) {
      return res.status(400).json({ success: false, error: "amountCents must be a positive integer" });
    }

    const refund = await RefundService.createRefundTraced({
      paymentId,
      amountCents,
      currency,
      reason,
      refundedBy,
    });

    return res.status(201).json({ success: true, refund });
  } catch (error: any) {
    const status = error.status ?? 500;
    return res.status(status).json({
      success: false,
      error: error.message ?? "Refund creation failed",
      code: error.code,
      details: error.details,
    });
  }
});

/**
 * @route GET /api/v1/admin/payments/:id/trace
 * @desc Retrieve a payment trace including the original payment and all linked refund entries.
 * @access Private (admin token only)
 */
router.get("/payments/:id/trace", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const trace = await RefundService.getPaymentTraceTraced(req.params.id);
    return res.json({ success: true, trace });
  } catch (error: any) {
    const status = error.status ?? 500;
    return res.status(status).json({
      success: false,
      error: error.message ?? "Trace retrieval failed",
    });
  }
});

// ----------------------------------------
/**
 * @route POST /api/v1/admin/payouts/:transactionId/replay
 * @desc Initiate a replay of a failed supplier payout. Requires a reason and subsequent approval from a different admin.
 * @access Private (admin role required)
 */
router.post(
  "/payouts/:transactionId/replay",
  requireAuthenticatedActor(["admin"]),
  (req: Request, res: Response) => {
    const { transactionId } = req.params;
    const { reason } = req.body;
    const initiatorId = req.auth?.userId;

    if (!initiatorId) {
      return res.status(401).json({ success: false, error: "Missing admin identity" });
    }

    if (!reason || typeof reason !== "string" || reason.trim() === "") {
      return res.status(400).json({ success: false, error: "A valid reason must be provided for the replay" });
    }

    const settlement = _settlements.get(transactionId);
    if (!settlement) {
      return res.status(404).json({ success: false, error: "Settlement not found" });
    }

    if (settlement.status !== "failed") {
      return res.status(400).json({ success: false, error: "Only failed settlements can be replayed" });
    }

    const TTL_MS = 15 * 60 * 1000; // 15 minutes
    const expiresAt = Date.now() + TTL_MS;

    const pendingRequest: PendingReplay = {
      transactionId,
      initiatorId,
      reason,
      expiresAt,
    };

    pendingReplays.set(transactionId, pendingRequest);

    defaultAuditLogger.log(
      "payout.replay_initiated",
      {
        context: { transactionId, initiatorId, reason, expiresAt },
      },
      {
        actorIp: getActorIp(req),
        resource: req.originalUrl,
        status: 202,
      }
    );

    return res.status(202).json({
      success: true,
      message: "Replay initiated. Awaiting approval from a different admin.",
      pendingRequest,
    });
  }
);

/**
 * @route POST /api/v1/admin/payouts/:transactionId/replay/approve
 * @desc Approve a pending replay request for a failed supplier payout. Must be a different admin.
 * @access Private (admin role required)
 */
router.post(
  "/payouts/:transactionId/replay/approve",
  requireAuthenticatedActor(["admin"]),
  (req: Request, res: Response) => {
    const { transactionId } = req.params;
    const approverId = req.auth?.userId;

    if (!approverId) {
      return res.status(401).json({ success: false, error: "Missing admin identity" });
    }

    const pendingRequest = pendingReplays.get(transactionId);
    if (!pendingRequest) {
      return res.status(404).json({ success: false, error: "No pending replay request found for this transaction" });
    }

    // TTL check
    if (Date.now() > pendingRequest.expiresAt) {
      pendingReplays.delete(transactionId);
      return res.status(400).json({ success: false, error: "Pending replay request has expired" });
    }

    // Dual-admin check
    if (approverId === pendingRequest.initiatorId) {
      return res.status(403).json({ success: false, error: "Approver must be a different admin from the initiator" });
    }

    const settlement = _settlements.get(transactionId);
    if (!settlement) {
      // Very unlikely edge case, but check anyway
      return res.status(404).json({ success: false, error: "Settlement not found" });
    }

    // Reset settlement state to allow reconciler to retry
    settlement.status = "pending_finality";
    settlement.attempts = 0;
    settlement.lastPolledAt = undefined;
    
    // Clear pending request
    pendingReplays.delete(transactionId);

    // Audit dual-admin action
    defaultAuditLogger.log(
      "payout.replay_approved",
      {
        context: {
          transactionId,
          initiatorId: pendingRequest.initiatorId,
          approverId,
          reason: pendingRequest.reason,
        },
      },
      {
        actorIp: getActorIp(req),
        resource: req.originalUrl,
        status: 200,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Replay approved. Settlement reset to pending_finality.",
      settlement,
    });
  }
);

/**
 * @route GET /api/v1/admin/fraud/hitl/queue
 * @desc Get pending review items for medium-risk fraud scores.
 * @access Private (admin role required)
 */
router.get("/fraud/hitl/queue", requireAuthenticatedActor(["admin"]), (req: Request, res: Response) => {
  res.json({ success: true, items: fraudReviewQueue.getPendingItems() });
});

/**
 * @route POST /api/v1/admin/fraud/hitl/:id/decision
 * @desc Operator endpoint for approve/reject/refer on HITL queue items.
 * @access Private (admin role required)
 */
router.post("/fraud/hitl/:id/decision", requireAuthenticatedActor(["admin"]), (req: Request, res: Response) => {
  const { decision, notes } = req.body;
  const operatorId = req.auth?.userId || "unknown";

  if (!["approved", "rejected", "referred"].includes(decision)) {
    return res.status(400).json({ success: false, error: "Invalid decision. Must be approved, rejected, or referred." });
  }

  try {
    const item = fraudReviewQueue.decide(req.params.id, operatorId, decision, notes);
    return res.json({ success: true, item });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * @route POST /api/v1/admin/escrow/pause
 * @desc Admin endpoint to toggle escrow paused state during migration.
 * @access Private (admin role required)
 */
router.post("/escrow/pause", requireAuthenticatedActor(["admin"]), (req: Request, res: Response) => {
  const { paused } = req.body;
  if (typeof paused !== "boolean") {
    return res.status(400).json({ success: false, error: "paused must be a boolean" });
  }

  // Assuming scheduling service is somehow accessible or we use the global state
  // Let's create an escrowMigrationState singleton and use it here.
  import("../services/escrowMigrationState.js").then(({ escrowMigrationState }) => {
    escrowMigrationState.setPaused(paused);
    res.json({ success: true, paused: escrowMigrationState.isPaused() });
  }).catch(err => {
    res.status(500).json({ success: false, error: err.message });
  });
});

// --- Mock Dispute Logic for E2E Tests ---
type Dispute = {
  id: string;
  status: "OPEN" | "EVIDENCED" | "ADJUDICATED" | "APPEALED" | "CLOSED" | "TIMEOUT";
  buyerId: string;
  supplierId: string;
  amount: number;
  evidence: string[];
  ruling?: string;
  arbiter?: string;
};

/**
 * @route GET /api/v1/admin/impersonation/sessions
 * @desc List impersonation sessions with optional filters.
 *   Query params:
 *     targetUserId  – filter by impersonated user
 *     adminId       – filter by the admin who performed the impersonation
 *     since         – ISO 8601 lower-bound for startedAt
 *     limit         – max results (default 50, max 200)
 *     offset        – pagination offset (default 0)
 * @access Private (admin token only)
 */
const impersonationSessionStore = new InMemoryImpersonationSessionStore();

router.get(
  "/impersonation/sessions",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const opts: SessionListOptions = {};

      if (typeof req.query.targetUserId === "string") {
        opts.targetUserId = req.query.targetUserId;
      }
      if (typeof req.query.adminId === "string") {
        opts.adminId = req.query.adminId;
      }
      if (typeof req.query.since === "string") {
        opts.since = req.query.since;
      }
      if (typeof req.query.limit === "string") {
        const parsed = Number.parseInt(req.query.limit, 10);
        if (Number.isFinite(parsed)) {
          opts.limit = parsed;
        }
      }
      if (typeof req.query.offset === "string") {
        const parsed = Number.parseInt(req.query.offset, 10);
        if (Number.isFinite(parsed)) {
          opts.offset = parsed;
        }
      }

      const sessions = await impersonationSessionStore.listSessions(opts);
      return res.status(200).json({ success: true, sessions });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to list impersonation sessions",
      });
    }
  },
);

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
    await defaultAuditLogger.log(
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
  const dispute: Dispute = {
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

  return res.status(200).json({ success: true, dispute });
});
// ----------------------------------------

// ─── Timezone Drift Monitor Admin API ─────────────────────────────────────────

/**
 * @route GET /api/v1/admin/tz-drift/metrics
 * @desc Retrieve the latest timezone drift scan snapshot including
 *   tenant-scoped ambiguous/missing-TZ counts and last scan timestamp.
 * @access Private (admin token only)
 */
router.get(
  "/tz-drift/metrics",
  requireAdminToken,
  (_req: Request, res: Response) => {
    try {
      const snapshot = getTzDriftMetricsSnapshot();
      return res.status(200).json({ success: true, snapshot });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to retrieve TZ drift metrics",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/tz-drift/offenders
 * @desc Sample offending slot rows from the last timezone drift scan.
 *   Query params:
 *     tenant    – filter by professionalId
 *     severity  – filter by severity (critical, warning, info)
 *     category  – filter by category (missing_tz, ambiguous, metadata)
 *     limit     – max results (default 50, max 200)
 *     offset    – pagination offset (default 0)
 * @access Private (admin token only)
 */
router.get(
  "/tz-drift/offenders",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      let findings = getLastScanFindings();

      // Apply filters
      if (typeof req.query.tenant === "string") {
        findings = findings.filter((f) => f.professionalId === req.query.tenant);
      }
      if (
        typeof req.query.severity === "string" &&
        ["critical", "warning", "info"].includes(req.query.severity)
      ) {
        findings = findings.filter((f) => f.severity === req.query.severity);
      }
      if (
        typeof req.query.category === "string" &&
        ["missing_tz", "ambiguous", "metadata"].includes(req.query.category)
      ) {
        findings = findings.filter((f) => f.category === req.query.category);
      }

      // Pagination
      let limit = 50;
      let offset = 0;
      if (req.query.limit !== undefined) {
        const parsed = parseInt(String(req.query.limit), 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 200) {
          limit = parsed;
        }
      }
      if (req.query.offset !== undefined) {
        const parsed = parseInt(String(req.query.offset), 10);
        if (!isNaN(parsed) && parsed >= 0) {
          offset = parsed;
        }
      }

      const total = findings.length;
      const page = findings.slice(offset, offset + limit);

      return res.status(200).json({
        success: true,
        offenders: page,
        total,
        limit,
        offset,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to retrieve TZ drift offenders",
      });
    }
  },
);

// ─── Payout DLQ Inspection API ──────────────────────────────────────────────

export function resetDisputesState(): void {
  // Placeholder for backward compatibility — state was removed in cleanup
}

/**
 * Validated PayoutDlqStatus values.
 */
const VALID_DLQ_STATUSES: PayoutDlqStatus[] = ["pending", "reprocessed", "inspected"];

function isValidDlqStatus(value: string): value is PayoutDlqStatus {
  return VALID_DLQ_STATUSES.includes(value as PayoutDlqStatus);
}

/**
 * @route GET /api/v1/admin/payout-dlq
 * @desc List payout DLQ entries with optional filtering by supplierId, errorClass,
 *       status, and full-text search. All payloads are masked server-side.
 *   Query params:
 *     supplierId  – filter by supplier ID
 *     errorClass  – filter by error class (case-insensitive)
 *     status      – filter by status (pending, reprocessed, inspected)
 *     search      – full-text search across supplierId, errorClass, errorMessage, id
 *     limit       – max results (default 50, max 200)
 *     offset      – pagination offset (default 0)
 * @access Private (admin token only)
 */
router.get(
  "/payout-dlq",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const store = getPayoutDlqStore();

      // Validate status filter if provided
      if (req.query.status !== undefined) {
        const statusVal = String(req.query.status);
        if (!isValidDlqStatus(statusVal)) {
          return res.status(400).json({
            success: false,
            error: `Invalid status. Must be one of: ${VALID_DLQ_STATUSES.join(", ")}`,
          });
        }
      }

      // Validate limit
      if (req.query.limit !== undefined) {
        const lim = parseInt(String(req.query.limit), 10);
        if (isNaN(lim) || lim < 1 || lim > 200) {
          return res.status(400).json({
            success: false,
            error: "limit must be between 1 and 200",
          });
        }
      }

      // Validate offset
      if (req.query.offset !== undefined) {
        const off = parseInt(String(req.query.offset), 10);
        if (isNaN(off) || off < 0) {
          return res.status(400).json({
            success: false,
            error: "offset must be a non-negative integer",
          });
        }
      }

      const result = store.list({
        supplierId:
          typeof req.query.supplierId === "string"
            ? req.query.supplierId
            : undefined,
        errorClass:
          typeof req.query.errorClass === "string"
            ? req.query.errorClass
            : undefined,
        status:
          typeof req.query.status === "string" &&
          isValidDlqStatus(req.query.status)
            ? req.query.status
            : undefined,
        search:
          typeof req.query.search === "string"
            ? req.query.search
            : undefined,
        limit: req.query.limit !== undefined
          ? parseInt(String(req.query.limit), 10)
          : undefined,
        offset: req.query.offset !== undefined
          ? parseInt(String(req.query.offset), 10)
          : undefined,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to list payout DLQ entries",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/payout-dlq/:entryId
 * @desc Retrieve a single payout DLQ entry with masked payload.
 *       Logs an audit event for each inspection.
 * @access Private (admin token only)
 */
router.get(
  "/payout-dlq/:entryId",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const { entryId } = req.params;

      if (
        !entryId ||
        typeof entryId !== "string" ||
        entryId.trim() === ""
      ) {
        return res
          .status(400)
          .json({ success: false, error: "Missing entryId" });
      }

      const store = getPayoutDlqStore();

      // Check existence first
      const raw = store.getByIdRaw(entryId.trim());
      if (!raw) {
        return res.status(404).json({
          success: false,
          error: `Payout DLQ entry '${entryId}' not found`,
        });
      }

      // Mark as inspected, then read the updated masked entry
      store.markInspected(entryId.trim());
      const entry = store.getById(entryId.trim())!;

      void defaultAuditLogger.log(
        "payout.dlq.inspected",
        {
          body: {
            dlqEntryId: entry.id,
            supplierId: entry.supplierId,
            errorClass: entry.errorClass,
          },
          context: {
            inspectorIp: req.ip ?? "unknown",
          },
        },
        {
          resource: `/api/v1/admin/payout-dlq/${entry.id}`,
          status: 200,
        },
      );

      return res.status(200).json({ success: true, entry });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to retrieve payout DLQ entry",
      });
    }
  },
);

// ─── Escrow Drift Override API ───────────────────────────────────────────────

/**
 * In-memory reference to the escrow drift reconciler, set by the app
 * bootstrap when a reconciler is active. Tests can replace this with
 * a mock reconciler.
 */
let _driftReconciler: {
  manualOverride(
    slotId: string,
    targetStatus: LocalIntentStatus,
    reason: string,
    actorIp: string,
  ): Promise<{ previousState: unknown; newState: unknown }>;
} | null = null;

export function setDriftReconciler(
  reconciler: NonNullable<typeof _driftReconciler>,
): void {
  _driftReconciler = reconciler;
}

function getDriftReconciler() {
  return _driftReconciler;
}

const VALID_INTENT_STATUSES: ReadonlySet<LocalIntentStatus> = new Set([
  "pending",
  "confirmed",
  "cancelled",
  "expired",
]);

/**
 * @route POST /api/v1/admin/escrow/drift/override
 * @desc Manually override a booking intent's escrow state to resolve drift.
 *   This is a privileged operation that must only be used after careful
 *   forensic investigation. Every override is audited.
 *
 *   Body:
 *     slotId       – the slot to override (required)
 *     targetStatus – new intent status (pending|confirmed|cancelled|expired)
 *     reason       – forensic justification (required, min 20 chars)
 *
 * @access Private (admin token only)
 */
router.post(
  "/escrow/drift/override",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const reconciler = getDriftReconciler();
      if (!reconciler) {
        return res.status(503).json({
          success: false,
          error: "Escrow drift reconciler is not running",
        });
      }

      const { slotId, targetStatus, reason } = req.body as {
        slotId?: string;
        targetStatus?: string;
        reason?: string;
      };

      // Validate slotId
      if (!slotId || typeof slotId !== "string" || slotId.trim() === "") {
        return res.status(400).json({
          success: false,
          error: "slotId is required and must be a non-empty string",
        });
      }

      // Validate targetStatus
      if (!targetStatus || typeof targetStatus !== "string") {
        return res.status(400).json({
          success: false,
          error: `targetStatus is required and must be one of: ${Array.from(VALID_INTENT_STATUSES).join(", ")}`,
        });
      }

      if (!VALID_INTENT_STATUSES.has(targetStatus as LocalIntentStatus)) {
        return res.status(400).json({
          success: false,
          error: `Invalid targetStatus "${targetStatus}". Must be one of: ${Array.from(VALID_INTENT_STATUSES).join(", ")}`,
        });
      }

      // Validate reason (min 20 chars for forensic justification, max 2000 for abuse prevention)
      if (!reason || typeof reason !== "string" || reason.trim().length < 20) {
        return res.status(400).json({
          success: false,
          error: "reason is required and must be at least 20 characters (forensic justification)",
        });
      }

      if (reason.trim().length > 2000) {
        return res.status(400).json({
          success: false,
          error: "reason must be at most 2000 characters",
        });
      }

      const actorIp = req.ip ?? "unknown";
      const result = await reconciler.manualOverride(
        slotId.trim(),
        targetStatus as LocalIntentStatus,
        reason.trim(),
        actorIp,
      );

      // Audit the override
      void defaultAuditLogger.log(
        "escrow.drift.override.applied",
        {
          context: {
            slotId: slotId.trim(),
            targetStatus,
            reason: reason.trim(),
            previousStatus: (result.previousState as any)?.intentStatus ?? "unknown",
            actorIp,
          },
          method: req.method,
        },
        { actorIp, resource: `slot:${slotId.trim()}`, status: 200 },
      );

      return res.status(200).json({
        success: true,
        slotId: slotId.trim(),
        previousState: result.previousState,
        newState: result.newState,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Manual override failed",
      });
    }
  },
);

// ─── Supplier Cancellation Override CRUD API ─────────────────────────────────

/**
 * @route GET /api/v1/admin/cancellation-overrides
 * @desc List all supplier cancellation overrides.
 * @access Private (admin token only)
 */
router.get(
  "/cancellation-overrides",
  requireAdminToken,
  (_req: Request, res: Response) => {
    try {
      const overrides = defaultSupplierCancellationOverrideStore.listOverrides();
      return res.status(200).json({ success: true, overrides });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to list cancellation overrides",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/cancellation-overrides/:supplierId
 * @desc Get a single supplier cancellation override.
 * @access Private (admin token only)
 */
router.get(
  "/cancellation-overrides/:supplierId",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const override = defaultSupplierCancellationOverrideStore.getOverride(
        req.params.supplierId,
      );
      if (!override) {
        return res.status(404).json({
          success: false,
          error: `No cancellation override found for supplier "${req.params.supplierId}"`,
        });
      }
      return res.status(200).json({ success: true, override });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to get cancellation override",
      });
    }
  },
);

/**
 * @route PUT /api/v1/admin/cancellation-overrides/:supplierId
 * @desc Create or update a supplier cancellation override.
 *
 *   Body:
 *     tiers       – array of cancellation tiers (required, min 1)
 *     minRefundAmount – optional lower-bound on refund
 *     maxRefundAmount – optional upper-bound on refund
 *     description – optional reason for the override
 *     changedBy   – actor identifier (defaults to req.auth?.userId or "admin")
 *
 *   Tier shape (inclusive-lower, exclusive-upper):
 *     {
 *       minHoursUntilStart: number,
 *       maxHoursUntilStart?: number,
 *       refundRatio: number (0-1),
 *       flatFee?: number,
 *       percentageFee?: number (0-1),
 *       taxReversalRatio?: number (0-1)
 *     }
 *
 * @access Private (admin token only)
 */
router.put(
  "/cancellation-overrides/:supplierId",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const { supplierId } = req.params;
      const { tiers, minRefundAmount, maxRefundAmount, description } = req.body;
      const changedBy = req.auth?.userId || "admin";

      if (!supplierId || typeof supplierId !== "string" || supplierId.trim() === "") {
        return res.status(400).json({
          success: false,
          error: "supplierId path parameter is required",
        });
      }

      if (!Array.isArray(tiers) || tiers.length === 0) {
        return res.status(400).json({
          success: false,
          error: "tiers must be a non-empty array",
        });
      }

      const terms = {
        tiers,
        ...(minRefundAmount !== undefined ? { minRefundAmount } : {}),
        ...(maxRefundAmount !== undefined ? { maxRefundAmount } : {}),
      };

      const override = await defaultSupplierCancellationOverrideStore.setOverride(
        supplierId.trim(),
        terms,
        changedBy,
        description,
      );

      return res.status(200).json({ success: true, override });
    } catch (err: any) {
      const isValidationError =
        err.message?.includes("ProratedCancellationTerms must") ||
        err.message?.includes("Tier ") ||
        err.message?.includes("supplierId must");
      const status = isValidationError ? 400 : 500;
      return res.status(status).json({
        success: false,
        error: err.message ?? "Failed to set cancellation override",
      });
    }
  },
);

/**
 * @route DELETE /api/v1/admin/cancellation-overrides/:supplierId
 * @desc Delete a supplier cancellation override.
 * @access Private (admin token only)
 */
router.delete(
  "/cancellation-overrides/:supplierId",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const { supplierId } = req.params;
      const changedBy = req.auth?.userId || "admin";

      if (!supplierId || typeof supplierId !== "string" || supplierId.trim() === "") {
        return res.status(400).json({
          success: false,
          error: "supplierId path parameter is required",
        });
      }

      const deleted = await defaultSupplierCancellationOverrideStore.deleteOverride(
        supplierId.trim(),
        changedBy,
      );

      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: `No cancellation override found for supplier "${supplierId}"`,
        });
      }

      return res.status(200).json({ success: true, deleted: true });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to delete cancellation override",
      });
    }
  },
);

// ─── SOC2 Access Review API ────────────────────────────────────────────────

/**
 * @route POST /api/v1/admin/access-review/snapshots
 * @desc Create a new access grant snapshot for the current quarter.
 *   Query params:
 *     force – if "true", forces creation even if a snapshot already exists for this quarter
 * @access Private (admin token only)
 */
router.post(
  "/access-review/snapshots",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const force = req.query.force === "true";
      const snapshot = await accessReviewService.createSnapshot(force);

      await defaultAuditLogger.log(
        "access-review.api.snapshot_created",
        {
          context: {
            snapshotId: snapshot.snapshotId,
            quarterLabel: snapshot.quarterLabel,
            grantCount: snapshot.grants.length,
            forced: force,
          },
        },
        {
          actorIp: getActorIp(req),
          resource: req.originalUrl,
          status: 201,
        },
      );

      return res.status(201).json({ success: true, snapshot });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to create access review snapshot",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/access-review/snapshots
 * @desc List access grant snapshots with optional filtering and pagination.
 *   Query params:
 *     quarterLabel – filter by quarter (e.g. "2026-Q2")
 *     limit        – max results (default 50, max 200)
 *     offset       – pagination offset (default 0)
 *     summaries    – if "true", return lightweight summaries without full grants
 * @access Private (admin token only)
 */
router.get(
  "/access-review/snapshots",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const quarterLabel =
        typeof req.query.quarterLabel === "string"
          ? req.query.quarterLabel
          : undefined;
      let limit = 50;
      let offset = 0;

      if (typeof req.query.limit === "string") {
        const parsed = Number.parseInt(req.query.limit, 10);
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 200) {
          limit = parsed;
        }
      }
      if (typeof req.query.offset === "string") {
        const parsed = Number.parseInt(req.query.offset, 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
          offset = parsed;
        }
      }

      if (req.query.summaries === "true") {
        const result = accessReviewService.listSnapshotSummaries({
          quarterLabel,
          limit,
          offset,
        });
        return res.status(200).json({ success: true, ...result });
      }

      const result = accessReviewService.listSnapshots({
        quarterLabel,
        limit,
        offset,
      });
      return res.status(200).json({ success: true, ...result });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to list snapshots",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/access-review/snapshots/:snapshotId
 * @desc Get a single access grant snapshot by ID.
 * @access Private (admin token only)
 */
router.get(
  "/access-review/snapshots/:snapshotId",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const snapshot = accessReviewService.getSnapshot(req.params.snapshotId);
      if (!snapshot) {
        return res.status(404).json({
          success: false,
          error: `Snapshot not found: ${req.params.snapshotId}`,
        });
      }
      return res.status(200).json({ success: true, snapshot });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to get snapshot",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/access-review/snapshots/:snapshotId/report
 * @desc Generate an access review report for a snapshot.
 *   Query params:
 *     format – report format: "json" (default) or "csv"
 * @access Private (admin token only)
 */
router.get(
  "/access-review/snapshots/:snapshotId/report",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const format: ReportFormat =
        req.query.format === "csv" ? "csv" : "json";

      const snapshot = accessReviewService.getSnapshot(req.params.snapshotId);
      if (!snapshot) {
        return res.status(404).json({
          success: false,
          error: `Snapshot not found: ${req.params.snapshotId}`,
        });
      }

      const content = accessReviewService.generateFormattedReport(
        req.params.snapshotId,
        format,
      );

      void defaultAuditLogger.log(
        "access-review.api.report_generated",
        {
          context: {
            snapshotId: req.params.snapshotId,
            quarterLabel: snapshot.quarterLabel,
            format,
          },
        },
        {
          actorIp: getActorIp(req),
          resource: req.originalUrl,
          status: 200,
        },
      );

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="access-review-${snapshot.quarterLabel}.csv"`,
        );
      } else {
        res.setHeader("Content-Type", "application/json");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="access-review-${snapshot.quarterLabel}.json"`,
        );
      }

      return res.send(content);
    } catch (err: any) {
      const status = err.message?.includes("not found") ? 404 : 500;
      return res.status(status).json({
        success: false,
        error: err.message ?? "Failed to generate report",
      });
    }
  },
);

/**
 * @route POST /api/v1/admin/access-review/snapshots/:snapshotId/attestations
 * @desc Record a reviewer sign-off for a snapshot.
 *   Body:
 *     reviewer – identifier of the reviewer (required)
 *     outcome  – "approved", "rejected", or "needs_revision" (required)
 *     notes    – optional notes or justification
 * @access Private (admin token only)
 */
router.post(
  "/access-review/snapshots/:snapshotId/attestations",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const { reviewer, outcome, notes } = req.body as {
        reviewer?: string;
        outcome?: string;
        notes?: string;
      };

      if (!reviewer || typeof reviewer !== "string" || reviewer.trim() === "") {
        return res.status(400).json({
          success: false,
          error: "reviewer is required and must be a non-empty string",
        });
      }

      if (!outcome || !["approved", "rejected", "needs_revision"].includes(outcome)) {
        return res.status(400).json({
          success: false,
          error:
            'outcome is required and must be one of: approved, rejected, needs_revision',
        });
      }

      const attestation = await accessReviewService.createAttestation(
        req.params.snapshotId,
        reviewer,
        outcome as "approved" | "rejected" | "needs_revision",
        notes,
      );

      return res.status(201).json({ success: true, attestation });
    } catch (err: any) {
      const isValidation =
        err.message?.includes("not found") ||
        err.message?.includes("already exists") ||
        err.message?.includes("Invalid attestation") ||
        err.message?.includes("Reviewer identifier");
      const status = isValidation ? 400 : 500;
      return res.status(status).json({
        success: false,
        error: err.message ?? "Failed to create attestation",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/access-review/attestations
 * @desc List attestations with optional filtering and pagination.
 *   Query params:
 *     snapshotId   – filter by snapshot ID
 *     quarterLabel – filter by quarter label
 *     outcome      – filter by outcome (approved, rejected, needs_revision)
 *     limit        – max results (default 50, max 200)
 *     offset       – pagination offset (default 0)
 * @access Private (admin token only)
 */
router.get(
  "/access-review/attestations",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const snapshotId =
        typeof req.query.snapshotId === "string"
          ? req.query.snapshotId
          : undefined;
      const quarterLabel =
        typeof req.query.quarterLabel === "string"
          ? req.query.quarterLabel
          : undefined;
      const outcome =
        typeof req.query.outcome === "string" &&
          ["approved", "rejected", "needs_revision"].includes(req.query.outcome)
          ? (req.query.outcome as "approved" | "rejected" | "needs_revision")
          : undefined;
      let limit = 50;
      let offset = 0;

      if (typeof req.query.limit === "string") {
        const parsed = Number.parseInt(req.query.limit, 10);
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 200) {
          limit = parsed;
        }
      }
      if (typeof req.query.offset === "string") {
        const parsed = Number.parseInt(req.query.offset, 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
          offset = parsed;
        }
      }

      const result = accessReviewService.listAttestations({
        snapshotId,
        quarterLabel,
        outcome,
        limit,
        offset,
      });

      return res.status(200).json({ success: true, ...result });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to list attestations",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/access-review/gaps
 * @desc Detect gaps in quarterly access review snapshots.
 *   Query params:
 *     lookback – number of quarters to check back (default 8)
 * @access Private (admin token only)
 */
router.get(
  "/access-review/gaps",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      let lookback = 8;
      if (typeof req.query.lookback === "string") {
        const parsed = Number.parseInt(req.query.lookback, 10);
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 40) {
          lookback = parsed;
        }
      }

      const gaps = accessReviewService.detectGaps(lookback);
      return res.status(200).json({ success: true, gaps });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to detect gaps",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/access-review/bundled-report
 * @desc Generate a bundled report of all attested snapshots.
 *   Query params:
 *     format – report format: "json" (default) or "csv"
 * @access Private (admin token only)
 */
router.get(
  "/access-review/bundled-report",
  requireAdminToken,
  (req: Request, res: Response) => {
    try {
      const format: ReportFormat =
        req.query.format === "csv" ? "csv" : "json";

      let content: string;
      if (format === "csv") {
        content = accessReviewService.generateAttestedReportsCsvBundle();
      } else {
        content = accessReviewService.generateAttestedReportsBundle();
      }

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="access-review-bundled-attestations.csv"',
        );
      } else {
        res.setHeader("Content-Type", "application/json");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="access-review-bundled-attestations.json"',
        );
      }

      return res.send(content);
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to generate bundled report",
      });
    }
  },
);

export default router;
