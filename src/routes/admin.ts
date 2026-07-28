import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { auditExportService } from "../services/auditExportService.js";
import { capacityForecaster } from "../services/capacityForecaster.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import {
  appendFinalityLink,
  canTransition,
  decideByMajority,
  getSeniorPool,
  isWithinAppealWindow,
  resetSeniorPool,
  selectSeniorPanel,
  SENIOR_PANEL_MIN_SIZE,
  validateSeniorDecision,
} from "../services/disputeAppeals.js";
import { AUDIT_SCHEMA_VERSION } from "../types/auditEvent.js";
import type {
  Dispute,
  DisputeStatus,
  SeniorPanelVote,
} from "../types/dispute.js";
import fraudModelsRouter from "./fraudModels.js";

const router = Router();

/**
 * Mount the fraud model registry surface under `/api/v1/admin/fraud-models`.
 * The sub-router exposes relative paths (`/promote`, `/list`) so the final
 * URLs become `/api/v1/admin/fraud-models/promote` and
 * `/api/v1/admin/fraud-models/list`.
 */
router.use("/fraud-models", fraudModelsRouter);

function buildBaseUrl(req: Request): string {
  const scheme = req.protocol;
  const host = req.get("host") ?? "localhost";
  return `${scheme}://${host}`;
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

// --- Mock Dispute Logic with Senior-Panel Appeal Workflow ---
//
// State machine (enforced by src/services/disputeAppeals.ts):
//   OPEN → EVIDENCED → ADJUDICATED → APPEALED → SENIOR_REVIEW → FINAL
// Appeals are accepted only within an `appealWindowMs` window after
// `adjudicatedAt` (default 72 h). The senior panel is selected from a
// module-level pool that excludes the original arbiter, any arbiter
// affiliated with the buyer's or supplier's tenant, and any arbiter who
// already served on a prior panel for the same dispute (appeal-of-appeal).
// Every status transition appends a SHA-256 hash link that chains to the
// previous one, so the lifecycle can be replayed from the chain alone.
//
// Audit envelope: each transition emits an event via `defaultAuditLogger`
// with `action= DISPUTE_APPEAL_INITIATED | DISPUTE_APPEAL_REJECTED |
// DISPUTE_SENIOR_PANEL_SELECTED | DISPUTE_FINAL` (plus
// `DISPUTE_FINAL_REJECTED`). The route never blocks on audit write
// failures; `logAudit()` swallows errors so a flaky disk does not stall
// the dispute pipeline.

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
router.get(
  "/impersonation/sessions",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const opts: SessionListOptions = {};

export const resetDisputesState = () => {
  disputes.clear();
  ledgers = { buyer: 1000, supplier: 1000 };
  resetSeniorPool();
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

export default router;
