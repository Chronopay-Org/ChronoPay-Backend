import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { auditExportService } from "../services/auditExportService.js";
import { capacityForecaster } from "../services/capacityForecaster.js";
import { RefundService } from "../services/refund.js";
import { getImpersonationSessionStore } from "../services/impersonationSessionStore.js";
import type { SessionListOptions } from "../types/impersonation.types.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { IMPERSONATION_AUDIT_ACTIONS } from "../types/auditEvent.js";

const router = Router();

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

const disputes = new Map<string, Dispute>();
let ledgers = { buyer: 1000, supplier: 1000 };

export const resetDisputesState = () => {
  disputes.clear();
  ledgers = { buyer: 1000, supplier: 1000 };
};

router.post("/disputes", requireAdminToken, (req, res) => {
  const { buyerId, supplierId, amount } = req.body;
  const id = `dispute-${Date.now()}`;
  disputes.set(id, {
    id,
    status: "OPEN",
    buyerId,
    supplierId,
    amount,
    evidence: [],
  });
  return res.status(201).json({ success: true, dispute: disputes.get(id) });
});

router.post("/disputes/:id/evidence", requireAdminToken, (req, res) => {
  const dispute = disputes.get(req.params.id);
  if (!dispute) return res.status(404).json({ success: false, error: "Dispute not found" });
  if (req.body.failUpload) return res.status(500).json({ success: false, error: "Evidence upload failed" });
  
  dispute.evidence.push(req.body.evidence);
  dispute.status = "EVIDENCED";
  return res.status(200).json({ success: true, dispute, evidenceAnchor: `anchor-${Date.now()}` });
});
// ─── Impersonation Session Review API ────────────────────────────────────────

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

      if (typeof req.query.targetUserId === "string") {
        opts.targetUserId = req.query.targetUserId;
      }
      if (typeof req.query.adminId === "string") {
        opts.adminId = req.query.adminId;
      }
      if (typeof req.query.since === "string") {
        const ts = new Date(req.query.since);
        if (isNaN(ts.getTime())) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid 'since' timestamp" });
        }
        opts.since = ts.toISOString();
      }
      if (req.query.limit !== undefined) {
        const lim = parseInt(String(req.query.limit), 10);
        if (isNaN(lim) || lim < 1 || lim > 200) {
          return res
            .status(400)
            .json({ success: false, error: "limit must be between 1 and 200" });
        }
        opts.limit = lim;
      }
      if (req.query.offset !== undefined) {
        const off = parseInt(String(req.query.offset), 10);
        if (isNaN(off) || off < 0) {
          return res
            .status(400)
            .json({ success: false, error: "offset must be a non-negative integer" });
        }
        opts.offset = off;
      }

      const store = getImpersonationSessionStore();
      const sessions = await store.listSessions(opts);

      return res.status(200).json({ success: true, sessions });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to list impersonation sessions",
      });
    }
  },
);

/**
 * @route GET /api/v1/admin/impersonation/sessions/:sessionId
 * @desc Retrieve a full impersonation session record including all request logs.
 * @access Private (admin token only)
 */
router.get(
  "/impersonation/sessions/:sessionId",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;

      if (!sessionId || typeof sessionId !== "string" || sessionId.trim() === "") {
        return res.status(400).json({ success: false, error: "Missing sessionId" });
      }

      const store = getImpersonationSessionStore();
      const session = await store.getSession(sessionId.trim());

      if (!session) {
        return res.status(404).json({
          success: false,
          error: `Impersonation session '${sessionId}' not found`,
        });
      }

      // Audit the review access itself
      void defaultAuditLogger.logImpersonationEvent(
        "impersonation.session.reviewed",
        {
          impersonationSessionId: session.sessionId,
          adminId: session.adminId,
          targetUserId: session.targetUserId,
        },
        { reviewedBy: req.ip ?? "unknown" },
      );

      return res.status(200).json({ success: true, session });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to retrieve impersonation session",
      });
    }
  },
);

/**
 * @route POST /api/v1/admin/impersonation/sessions/:sessionId/close
 * @desc Manually close an active impersonation session.
 *   Useful when the front-end token expires before the server-side TTL.
 * @access Private (admin token only)
 */
router.post(
  "/impersonation/sessions/:sessionId/close",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;

      if (!sessionId || typeof sessionId !== "string" || sessionId.trim() === "") {
        return res.status(400).json({ success: false, error: "Missing sessionId" });
      }

      const store = getImpersonationSessionStore();
      const existing = await store.getSession(sessionId.trim());

      if (!existing) {
        return res.status(404).json({
          success: false,
          error: `Impersonation session '${sessionId}' not found`,
        });
      }

      const closed = await store.closeSession(sessionId.trim());

      void defaultAuditLogger.logImpersonationEvent(
        IMPERSONATION_AUDIT_ACTIONS.SESSION_CLOSED,
        {
          impersonationSessionId: closed.sessionId,
          adminId: closed.adminId,
          targetUserId: closed.targetUserId,
        },
        { closedBy: "admin-api", requestCount: closed.requests.length },
      );

      return res.status(200).json({ success: true, session: closed });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message ?? "Failed to close impersonation session",
      });
    }
  },
);

export default router;
