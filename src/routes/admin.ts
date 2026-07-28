import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { auditExportService } from "../services/auditExportService.js";
import { getImpersonationSessionStore } from "../services/impersonationSessionStore.js";
import type { SessionListOptions } from "../types/impersonation.types.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { IMPERSONATION_AUDIT_ACTIONS } from "../types/auditEvent.js";
import { getPayoutDlqStore, type PayoutDlqStatus } from "../services/payoutDlqStore.js";

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

// ─── Payout DLQ Inspection API ──────────────────────────────────────────────

// In-memory dispute state for testing (kept for backward compatibility)
let disputesState: Map<string, any> = new Map();

export function resetDisputesState(): void {
  disputesState = new Map();
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

export default router;
