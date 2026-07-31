/**
 * @file src/routes/admin/scheduler.ts
 *
 * Admin control-plane for the incident scheduler kill-switch. Mounted under
 * `/api/v1/admin/scheduler`.
 *
 *   POST /pause    – freeze new booking-intent creation platform-wide
 *   POST /resume   – lift the freeze
 *   GET  /status   – read the current pause state (read path)
 *
 * Every mutating action:
 *   - Requires the shared admin token (`requireAdminToken`).
 *   - Requires an explicit `initiated_by` in the body so the acting operator is
 *     recorded rather than the anonymous shared token.
 *   - Increments the relevant Prometheus counter.
 *   - Broadcasts the new status on the WebSocket status bus.
 *   - Writes a best-effort audit event.
 */

import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../../middleware/authorization.js";
import {
  pauseScheduler,
  resumeScheduler,
  readSchedulerPauseState,
  RedisUnavailableError,
} from "../../redis.js";
import { schedulerPauseTotal, schedulerResumeTotal } from "../../metrics.js";
import { broadcastSchedulerStatus } from "../../services/schedulerStatusBus.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";
import { logger } from "../../utils/logger.js";

const router = Router();

function auditFireAndForget(
  action: string,
  context: Record<string, unknown>,
  req: Request,
  status: number | string,
): void {
  /* istanbul ignore next -- req.ip is always populated behind supertest/Express;
     the socket fallback only matters in exotic transports */
  const actorIp = req.ip || req.socket?.remoteAddress;
  void defaultAuditLogger
    .log(action, { method: req.method, context }, { actorIp, resource: req.originalUrl, status })
    .catch(() => undefined);
}

function readStringField(body: unknown, ...keys: string[]): string {
  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function redisUnavailable(res: Response): Response {
  return res.status(503).json({
    success: false,
    code: "REDIS_UNAVAILABLE",
    error: "Cannot reach Redis to read or update the scheduler flag.",
  });
}

/**
 * Central error mapping for the async handlers. Async Express-4 handlers must
 * not `throw` (the rejection would not reach the error middleware), so every
 * handler funnels failures through here.
 */
function handleError(res: Response, err: unknown): Response {
  if (err instanceof RedisUnavailableError) {
    return redisUnavailable(res);
  }
  logger.error({ err }, "scheduler control-plane: unexpected error");
  return res.status(500).json({
    success: false,
    code: "INTERNAL_ERROR",
    error: "Internal server error",
  });
}

// ---------------------------------------------------------------------------
// POST /pause
// ---------------------------------------------------------------------------
router.post("/pause", requireAdminToken, async (req: Request, res: Response) => {
  const reason = readStringField(req.body, "reason");
  const initiatedBy = readStringField(req.body, "initiated_by", "initiatedBy");

  if (!reason) {
    return res
      .status(400)
      .json({ success: false, code: "INVALID_REASON", error: "reason is required" });
  }
  if (!initiatedBy) {
    return res.status(400).json({
      success: false,
      code: "INVALID_INITIATED_BY",
      error: "initiated_by is required",
    });
  }

  try {
    const state = await pauseScheduler({ reason, initiatedBy });
    schedulerPauseTotal.inc();
    broadcastSchedulerStatus(state);
    auditFireAndForget("SCHEDULER_PAUSED", { reason, initiatedBy }, req, 200);
    return res.status(200).json({ success: true, scheduler: state });
  } catch (err) {
    return handleError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /resume
// ---------------------------------------------------------------------------
router.post("/resume", requireAdminToken, async (req: Request, res: Response) => {
  const initiatedBy = readStringField(req.body, "initiated_by", "initiatedBy");

  if (!initiatedBy) {
    return res.status(400).json({
      success: false,
      code: "INVALID_INITIATED_BY",
      error: "initiated_by is required",
    });
  }

  try {
    const state = await resumeScheduler({ initiatedBy });
    schedulerResumeTotal.inc();
    broadcastSchedulerStatus(state);
    auditFireAndForget("SCHEDULER_RESUMED", { initiatedBy }, req, 200);
    return res.status(200).json({ success: true, scheduler: state });
  } catch (err) {
    return handleError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /status — read path, safe to call during a freeze
// ---------------------------------------------------------------------------
router.get("/status", requireAdminToken, async (_req: Request, res: Response) => {
  try {
    const state = await readSchedulerPauseState();
    return res.status(200).json({ success: true, scheduler: state });
  } catch (err) {
    return handleError(res, err);
  }
});

export default router;
