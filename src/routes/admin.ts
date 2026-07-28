import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { auditExportService } from "../services/auditExportService.js";
import { capacityForecaster } from "../services/capacityForecaster.js";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { _settlements } from "../services/settlementReconciler.js";

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
        actorIp: req.ip?.replace("::ffff:", "") || req.socket?.remoteAddress?.replace("::ffff:", "") || "127.0.0.1",
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
        actorIp: req.ip?.replace("::ffff:", "") || req.socket?.remoteAddress?.replace("::ffff:", "") || "127.0.0.1",
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
