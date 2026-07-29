/**
 * dsrSlaWorker
 *
 * Polls the DSR SLA table on a configurable interval and fires tiered
 * countdown alerts at the 7-day, 3-day, and 1-day thresholds.
 *
 * Design goals:
 *   - Fully injectable: service, alerter, logger, and clock are all
 *     constructor/option params so tests never touch I/O.
 *   - Idempotent: markAlertSent is called immediately after a successful
 *     alert dispatch; if the process crashes between the two calls the
 *     scheduler will re-fire on the next cycle (acceptable—alerting twice
 *     is safer than never alerting).
 *   - Observable: every cycle emits structured log lines; callers can
 *     inject a custom alerter to forward to Slack, PagerDuty, email, etc.
 *   - Graceful shutdown: `stop()` sets a flag and resolves on the next
 *     idle tick; `runOnce()` is exported for one-shot CLI/test use.
 */

import {
  DsrSlaService,
  dsrSlaService as defaultDsrSlaService,
  ALERT_THRESHOLDS,
  type AlertThreshold,
  type DsrRecord,
} from "../services/dsrSlaService.js";
import { defaultAuditLogger, type AuditLogger } from "../services/auditLogger.js";

// ─── Alerter abstraction ─────────────────────────────────────────────────────

export interface DsrAlertPayload {
  dsrId: string;
  subjectId: string;
  requestType: string;
  dueAt: Date;
  daysRemaining: number;
  threshold: AlertThreshold;
}

/**
 * Alert dispatcher.  The default implementation writes a structured audit
 * log entry; swap it in production for a channel that pages on-call staff.
 */
export type AlertFn = (payload: DsrAlertPayload) => Promise<void>;

// ─── Worker options ──────────────────────────────────────────────────────────

export interface DsrSlaWorkerOptions {
  /** How often the worker polls (ms). Default: 60_000 (1 min). */
  intervalMs?: number;
  /** Injected service — defaults to the module-level singleton. */
  service?: DsrSlaService;
  /** Injected alert dispatcher. */
  alertFn?: AlertFn;
  /** Injected audit logger. */
  logger?: AuditLogger;
  /** Override "now" — used by tests to simulate clock state. */
  now?: () => Date;
}

// ─── Default alert implementation ────────────────────────────────────────────

function buildDefaultAlertFn(logger: AuditLogger): AlertFn {
  return async (payload: DsrAlertPayload) => {
    await logger.log(
      "dsr.sla_alert",
      {
        context: {
          dsrId: payload.dsrId,
          subjectId: payload.subjectId,
          requestType: payload.requestType,
          dueAt: payload.dueAt.toISOString(),
          daysRemaining: payload.daysRemaining,
          threshold: payload.threshold,
          message: `DSR ${payload.dsrId} is due in ${payload.daysRemaining} day(s) — SLA deadline approaching`,
        },
      },
      { status: "warning" },
    );
  };
}

// ─── Core cycle logic (exported for testing) ─────────────────────────────────

export interface CycleResult {
  alertsFired: number;
  errors: number;
  /** Per-threshold breakdown. */
  byThreshold: Record<AlertThreshold, { fired: number; errors: number }>;
}

/**
 * Run one full alert-check cycle across all three thresholds.
 * Safe to call concurrently (each threshold is independent).
 */
export async function runCycle(
  service: DsrSlaService,
  alertFn: AlertFn,
  now: Date,
): Promise<CycleResult> {
  const result: CycleResult = {
    alertsFired: 0,
    errors: 0,
    byThreshold: { 7: { fired: 0, errors: 0 }, 3: { fired: 0, errors: 0 }, 1: { fired: 0, errors: 0 } },
  };

  // Process thresholds from largest to smallest so the most-urgent fires last
  // and the audit trail reads chronologically.
  for (const threshold of ALERT_THRESHOLDS) {
    const pending = await service.findPendingAlerts(threshold, now);

    for (const dsr of pending) {
      try {
        await alertFn({
          dsrId: dsr.id,
          subjectId: dsr.subjectId,
          requestType: dsr.requestType,
          dueAt: dsr.dueAt,
          daysRemaining: dsr.daysRemaining ?? threshold,
          threshold,
        });

        // Mark sent only after successful dispatch (idempotency guard)
        await service.markAlertSent(dsr.id, threshold);

        result.alertsFired++;
        result.byThreshold[threshold].fired++;
      } catch (err) {
        // Never let one failing alert abort the rest of the cycle
        result.errors++;
        result.byThreshold[threshold].errors++;
        console.error(
          `[dsrSlaWorker] alert dispatch failed dsrId=${dsr.id} threshold=${threshold}d`,
          err,
        );
      }
    }
  }

  return result;
}

/**
 * Fire one complete poll cycle and return the result.
 * Convenience function for cron/CLI invocations.
 */
export async function runOnce(options: DsrSlaWorkerOptions = {}): Promise<CycleResult> {
  const service = options.service ?? defaultDsrSlaService;
  const logger = options.logger ?? defaultAuditLogger;
  const alertFn = options.alertFn ?? buildDefaultAlertFn(logger);
  const now = options.now ? options.now() : new Date();

  return runCycle(service, alertFn, now);
}

// ─── Long-running worker ──────────────────────────────────────────────────────

export class DsrSlaWorker {
  private readonly service: DsrSlaService;
  private readonly alertFn: AlertFn;
  private readonly logger: AuditLogger;
  private readonly intervalMs: number;
  private readonly nowFn: () => Date;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DsrSlaWorkerOptions = {}) {
    this.service = options.service ?? defaultDsrSlaService;
    this.logger = options.logger ?? defaultAuditLogger;
    this.alertFn = options.alertFn ?? buildDefaultAlertFn(this.logger);
    this.intervalMs = options.intervalMs ?? 60_000;
    this.nowFn = options.now ?? (() => new Date());
  }

  /** Start the poll loop. No-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
    console.log(`[dsrSlaWorker] started — polling every ${this.intervalMs}ms`);
  }

  /** Stop the poll loop gracefully. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log("[dsrSlaWorker] stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      const now = this.nowFn();
      const result = await runCycle(this.service, this.alertFn, now);

      if (result.alertsFired > 0 || result.errors > 0) {
        await this.logger.log(
          "dsr.sla_worker_cycle",
          {
            context: {
              alertsFired: result.alertsFired,
              errors: result.errors,
              byThreshold: result.byThreshold,
              cycleAt: now.toISOString(),
            },
          },
          { status: result.errors > 0 ? "partial_error" : "success" },
        );
      }
    } catch (err) {
      console.error("[dsrSlaWorker] cycle error", err);
    } finally {
      this.schedule();
    }
  }
}

/** Module-level singleton — start from `src/index.ts` if needed. */
export const dsrSlaWorker = new DsrSlaWorker();
