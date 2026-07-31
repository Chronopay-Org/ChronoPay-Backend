/**
 * @file src/middleware/schedulerGate.ts
 *
 * Express guard that freezes NEW booking-intent creation platform-wide while an
 * operator has paused the scheduler during an incident.
 *
 * Design contract
 * ───────────────
 * - Attach ONLY to mutating booking-intent create routes. Read paths (status,
 *   previews, listings) are intentionally left untouched so customers can still
 *   inspect existing bookings during a freeze.
 * - Fail OPEN: if the pause flag cannot be read (Redis outage), allow the
 *   request through and emit a warning. A kill-switch must never amplify an
 *   unrelated Redis incident into a full booking outage.
 * - Fail CLOSED only when the flag is explicitly set: respond `503` with a
 *   machine-readable `SCHEDULER_PAUSED` code and a `Retry-After` hint.
 */

import type { Request, Response, NextFunction } from "express";
import { readSchedulerPauseState } from "../redis.js";
import { logger } from "../utils/logger.js";

/** Seconds clients should wait before retrying while paused. */
const RETRY_AFTER_SECONDS = 120;

export async function schedulerGate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let state;
  try {
    state = await readSchedulerPauseState();
  } catch (err) {
    // Fail-open: cannot determine pause state → do not block traffic.
    logger.warn(
      { err, path: req.originalUrl },
      "schedulerGate: unable to read scheduler pause flag — failing open",
    );
    next();
    return;
  }

  if (!state.paused) {
    next();
    return;
  }

  logger.info(
    { path: req.originalUrl, reason: state.reason, initiatedBy: state.initiatedBy },
    "schedulerGate: rejecting booking-intent create — scheduler is paused",
  );

  res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
  res.status(503).json({
    success: false,
    error: "Booking creation is temporarily paused by an operator.",
    code: "SCHEDULER_PAUSED",
    reason: state.reason ?? null,
    initiatedBy: state.initiatedBy ?? null,
    pausedAt: state.pausedAt ?? null,
  });
}

export default schedulerGate;
