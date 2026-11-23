import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import {
  dsrSlaService,
  DsrSlaService,
  type DsrRequestType,
  type DsrStatus,
} from "../services/dsrSlaService.js";

/**
 * GDPR Data Subject Request (DSR) SLA admin routes.
 *
 * DsrSlaService owns the 30-day Art. 12(2) clock, the two-month Art. 12(3)
 * extension, and the 7/3/1-day alert thresholds. This module is only the
 * HTTP edge: authentication, input validation, and error-to-status mapping.
 *
 * Mounted by routes/admin.ts under /api/v1/admin, so every path here is
 * relative to that prefix.
 */

/** Service backing these routes. Swappable for tests via setDsrSlaService. */
let _service: DsrSlaService = dsrSlaService;

export function setDsrSlaService(service: DsrSlaService): void {
  _service = service;
}

/** Largest page size accepted by the DSR list endpoint. */
const MAX_LIMIT = 200;

/**
 * Art. 12(3) permits a single two-month extension, so /extend accepts at most
 * 60 additional days. Going beyond that needs a fresh legal assessment.
 */
const MAX_EXTENSION_DAYS = 60;

const REQUEST_TYPES: readonly DsrRequestType[] = [
  "access",
  "erasure",
  "rectification",
  "portability",
  "restriction",
  "objection",
];

const STATUSES: readonly DsrStatus[] = [
  "open",
  "in_progress",
  "resolved",
  "extended",
  "rejected",
];

/**
 * Maps a DSR service error onto an HTTP status. The service signals "no such
 * record" (and "record already terminal") through its message, so those become
 * 404; anything else is an unexpected failure and becomes 500.
 */
function handleServiceError(err: any, res: Response): Response {
  const message = err?.message ?? "DSR operation failed";
  const notFound = /not found|terminal state/i.test(message);
  return res.status(notFound ? 404 : 500).json({ success: false, error: message });
}

/** Rejects a missing/blank string field in place, naming the offending field. */
function requireStringField(
  value: unknown,
  field: string,
  res: Response,
): { ok: true; value: string } | { ok: false } {
  if (typeof value !== "string" || value.trim().length === 0) {
    res.status(400).json({ success: false, error: `${field} is required` });
    return { ok: false };
  }
  return { ok: true, value };
}

const router = Router();

/**
 * @route GET /api/v1/admin/gdpr/dsr/dashboard
 * @desc Aggregate counts for the GDPR DSR SLA dashboard.
 * @access Private (admin token only)
 */
router.get("/gdpr/dsr/dashboard", requireAdminToken, async (_req: Request, res: Response) => {
  try {
    const summary = await _service.getDashboardSummary();
    return res.status(200).json({ success: true, summary });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/gdpr/dsr
 * @desc List DSR records. Query params: ?status=&limit=&offset=
 * @access Private (admin token only)
 */
router.get("/gdpr/dsr", requireAdminToken, async (req: Request, res: Response) => {
  const options: Record<string, unknown> = {};

  if (req.query.status !== undefined) {
    const status = req.query.status as string;
    if (!STATUSES.includes(status as DsrStatus)) {
      return res.status(400).json({
        success: false,
        error: `status must be one of: ${STATUSES.join(", ")}`,
      });
    }
    options.status = status as DsrStatus;
  }

  if (req.query.limit !== undefined) {
    const limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return res.status(400).json({
        success: false,
        error: `limit must be an integer between 1 and ${MAX_LIMIT}`,
      });
    }
    options.limit = limit;
  }

  if (req.query.offset !== undefined) {
    const offset = Number(req.query.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      return res.status(400).json({
        success: false,
        error: "offset must be a non-negative integer",
      });
    }
    options.offset = offset;
  }

  try {
    const records = await _service.list(options);
    return res.status(200).json({ success: true, records });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route POST /api/v1/admin/gdpr/dsr
 * @desc Register a new data subject request, starting its 30-day SLA clock.
 * @access Private (admin token only)
 */
router.post("/gdpr/dsr", requireAdminToken, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const subjectId = requireStringField(body.subjectId, "subjectId", res);
  if (!subjectId.ok) return;
  const subjectEmail = requireStringField(body.subjectEmail, "subjectEmail", res);
  if (!subjectEmail.ok) return;

  if (!REQUEST_TYPES.includes(body.requestType as DsrRequestType)) {
    return res.status(400).json({
      success: false,
      error: `requestType must be one of: ${REQUEST_TYPES.join(", ")}`,
    });
  }

  let receivedAt: Date | undefined;
  if (body.receivedAt !== undefined) {
    const parsed = new Date(body.receivedAt as string);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({
        success: false,
        error: "receivedAt must be a valid ISO-8601 date",
      });
    }
    receivedAt = parsed;
  }

  try {
    const record = await _service.create({
      subjectId: subjectId.value,
      subjectEmail: subjectEmail.value,
      requestType: body.requestType as DsrRequestType,
      receivedAt,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    return res.status(201).json({ success: true, record });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/gdpr/dsr/:id
 * @desc Fetch a single DSR record with its computed daysRemaining.
 * @access Private (admin token only)
 */
router.get("/gdpr/dsr/:id", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const record = await _service.findById(req.params.id);
    if (!record) {
      return res.status(404).json({
        success: false,
        error: `DSR not found: ${req.params.id}`,
      });
    }
    return res.status(200).json({ success: true, record });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route PATCH /api/v1/admin/gdpr/dsr/:id/status
 * @desc Move a DSR to a non-terminal status. Terminal transitions are excluded
 *   on purpose — they go through /resolve and /extend so the audit fields
 *   (resolver, reason, evidence) can never be skipped.
 * @access Private (admin token only)
 */
router.patch("/gdpr/dsr/:id/status", requireAdminToken, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (!STATUSES.includes(body.status as DsrStatus)) {
    return res.status(400).json({
      success: false,
      error: `status must be one of: ${STATUSES.join(", ")}`,
    });
  }
  if (body.status === "resolved" || body.status === "extended") {
    return res.status(400).json({
      success: false,
      error: `status "${body.status}" is terminal — use /resolve or /extend instead`,
    });
  }

  try {
    const record = await _service.updateStatus(req.params.id, {
      status: body.status as Exclude<DsrStatus, "resolved" | "extended">,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    return res.status(200).json({ success: true, record });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route POST /api/v1/admin/gdpr/dsr/:id/resolve
 * @desc Close a DSR with a named resolver, reason and optional evidence link.
 * @access Private (admin token only)
 */
router.post("/gdpr/dsr/:id/resolve", requireAdminToken, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const resolvedBy = requireStringField(body.resolvedBy, "resolvedBy", res);
  if (!resolvedBy.ok) return;
  const resolutionReason = requireStringField(body.resolutionReason, "resolutionReason", res);
  if (!resolutionReason.ok) return;

  try {
    const record = await _service.resolve(req.params.id, {
      resolvedBy: resolvedBy.value,
      resolutionReason: resolutionReason.value,
      resolutionEvidence:
        typeof body.resolutionEvidence === "string" ? body.resolutionEvidence : undefined,
    });
    return res.status(200).json({ success: true, record });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route POST /api/v1/admin/gdpr/dsr/:id/extend
 * @desc Apply the Art. 12(3) two-month extension to a DSR's due date.
 * @access Private (admin token only)
 */
router.post("/gdpr/dsr/:id/extend", requireAdminToken, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const extensionReason = requireStringField(body.extensionReason, "extensionReason", res);
  if (!extensionReason.ok) return;

  let additionalDays: number | undefined;
  if (body.additionalDays !== undefined) {
    const days = Number(body.additionalDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_EXTENSION_DAYS) {
      return res.status(400).json({
        success: false,
        error: `additionalDays must be an integer between 1 and ${MAX_EXTENSION_DAYS}`,
      });
    }
    additionalDays = days;
  }

  try {
    const record = await _service.extend(req.params.id, {
      extensionReason: extensionReason.value,
      additionalDays,
    });
    return res.status(200).json({ success: true, record });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route POST /api/v1/admin/gdpr/dsr/:id/reopen
 * @desc Reopen a resolved/extended DSR, e.g. after a regulatory challenge.
 * @access Private (admin token only)
 */
router.post("/gdpr/dsr/:id/reopen", requireAdminToken, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const reason = requireStringField(body.reason, "reason", res);
  if (!reason.ok) return;

  try {
    const record = await _service.reopen(req.params.id, reason.value);
    return res.status(200).json({ success: true, record });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

export default router;
