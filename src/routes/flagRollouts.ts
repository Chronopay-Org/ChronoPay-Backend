/**
 * flagRollouts.ts (admin route)
 * ------------------------------
 * Routes mounted under `/api/v1/admin/flag-rollouts` (#570).
 *
 * POST   /                 – create a scheduled percentage rollout
 * GET    /                 – list rollout schedules (optional filters)
 * GET    /:id              – get a single schedule, including its history
 * POST   /:id/pause        – pause a schedule (freezes at its current %)
 * POST   /:id/resume       – resume a paused schedule (catches up to now)
 * POST   /:id/rollback     – roll back to an earlier step (terminal)
 *
 * All mutating actions require an `actor` in the request body — deliberately
 * NOT derived from the admin token itself, so the shared admin secret never
 * ends up recorded as an actor identity in audit logs or schedule history.
 */

import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import {
  RolloutScheduleError,
  getRolloutScheduleRegistry,
  type FeatureFlagName,
  type RolloutEnvironment,
  type RolloutStatus,
} from "../flags/index.js";

const router = Router();

const ERROR_STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  SCHEDULE_IN_FLIGHT: 409,
  ALREADY_PAUSED: 409,
  ALREADY_ROLLED_BACK: 409,
  INVALID_STATE_TRANSITION: 409,
  NOTHING_TO_ROLLBACK: 409,
};

function statusForError(err: RolloutScheduleError): number {
  return ERROR_STATUS_BY_CODE[err.code] ?? 400;
}

function handleRolloutError(res: Response, err: unknown): Response {
  if (err instanceof RolloutScheduleError) {
    return res.status(statusForError(err)).json({
      success: false,
      code: err.code,
      error: err.message,
    });
  }
  throw err;
}

function auditFireAndForget(
  action: string,
  context: Record<string, unknown>,
  req: Request,
  status: number | string,
): void {
  void defaultAuditLogger
    .log(
      action,
      { method: req.method, context },
      { actorIp: req.ip || req.socket?.remoteAddress, resource: req.originalUrl, status },
    )
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// POST / — create a rollout schedule
// ---------------------------------------------------------------------------

router.post("/", requireAdminToken, (req: Request, res: Response) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const { flag, tenantId, environment, steps, actor } = body as {
    flag?: FeatureFlagName;
    tenantId?: string;
    environment?: RolloutEnvironment;
    steps?: Array<{ percentage: number; at: string }>;
    actor?: string;
  };

  try {
    const registry = getRolloutScheduleRegistry();
    const schedule = registry.create({
      flag: flag as FeatureFlagName,
      tenantId: tenantId as string,
      environment: environment as RolloutEnvironment,
      steps: Array.isArray(steps) ? steps : [],
      actor: actor as string,
    });

    auditFireAndForget(
      "FLAG_ROLLOUT_CREATED",
      { scheduleId: schedule.id, flag: schedule.flag, tenantId: schedule.tenantId, environment: schedule.environment, steps: schedule.steps, actor: schedule.createdBy },
      req,
      201,
    );

    return res.status(201).json({ success: true, schedule });
  } catch (err) {
    return handleRolloutError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET / — list schedules (optional filters)
// ---------------------------------------------------------------------------

router.get("/", requireAdminToken, (req: Request, res: Response) => {
  const registry = getRolloutScheduleRegistry();
  const { flag, tenantId, environment, status } = req.query as Record<string, string | undefined>;

  const schedules = registry.list({
    flag: flag as FeatureFlagName | undefined,
    tenantId,
    environment: environment as RolloutEnvironment | undefined,
    status: status as RolloutStatus | undefined,
  });

  return res.status(200).json({ success: true, schedules });
});

// ---------------------------------------------------------------------------
// GET /:id — fetch a single schedule
// ---------------------------------------------------------------------------

router.get("/:id", requireAdminToken, (req: Request, res: Response) => {
  const registry = getRolloutScheduleRegistry();
  const schedule = registry.getById(req.params.id);

  if (!schedule) {
    return res.status(404).json({
      success: false,
      code: "NOT_FOUND",
      error: `Rollout schedule not found: ${req.params.id}`,
    });
  }

  return res.status(200).json({ success: true, schedule });
});

// ---------------------------------------------------------------------------
// POST /:id/pause
// ---------------------------------------------------------------------------

router.post("/:id/pause", requireAdminToken, (req: Request, res: Response) => {
  const { actor, reason } = (req.body ?? {}) as { actor?: string; reason?: string };

  try {
    const registry = getRolloutScheduleRegistry();
    const schedule = registry.pause(req.params.id, actor as string, reason);

    auditFireAndForget(
      "FLAG_ROLLOUT_PAUSED",
      { scheduleId: schedule.id, actor: schedule.history.at(-1)?.actor, reason },
      req,
      200,
    );

    return res.status(200).json({ success: true, schedule });
  } catch (err) {
    return handleRolloutError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/resume
// ---------------------------------------------------------------------------

router.post("/:id/resume", requireAdminToken, (req: Request, res: Response) => {
  const { actor } = (req.body ?? {}) as { actor?: string };

  try {
    const registry = getRolloutScheduleRegistry();
    const schedule = registry.resume(req.params.id, actor as string);

    auditFireAndForget(
      "FLAG_ROLLOUT_RESUMED",
      { scheduleId: schedule.id, actor, currentPercentage: schedule.currentPercentage },
      req,
      200,
    );

    return res.status(200).json({ success: true, schedule });
  } catch (err) {
    return handleRolloutError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/rollback
// ---------------------------------------------------------------------------

router.post("/:id/rollback", requireAdminToken, (req: Request, res: Response) => {
  const { actor, reason, toStepIndex } = (req.body ?? {}) as {
    actor?: string;
    reason?: string;
    toStepIndex?: number;
  };

  try {
    const registry = getRolloutScheduleRegistry();
    const schedule = registry.rollback({
      id: req.params.id,
      actor: actor as string,
      reason: reason as string,
      toStepIndex,
    });

    auditFireAndForget(
      "FLAG_ROLLOUT_ROLLED_BACK",
      { scheduleId: schedule.id, actor, reason, currentPercentage: schedule.currentPercentage },
      req,
      200,
    );

    return res.status(200).json({ success: true, schedule });
  } catch (err) {
    return handleRolloutError(res, err);
  }
});

export default router;
