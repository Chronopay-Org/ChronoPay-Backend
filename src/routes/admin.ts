import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { auditExportService } from "../services/auditExportService.js";
import { getImpersonationSessionStore } from "../services/impersonationSessionStore.js";
import type { SessionListOptions } from "../types/impersonation.types.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { IMPERSONATION_AUDIT_ACTIONS } from "../types/auditEvent.js";
import type { LocalIntentStatus } from "../services/escrowDriftReconciler.js";

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

export default router;
