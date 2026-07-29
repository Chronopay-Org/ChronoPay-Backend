/**
 * disputeDeadlineScheduler.ts
 * ----------------------------
 * Scheduler job that periodically scans all in-memory disputes and
 * auto-resolves those that have exceeded their inactivity grace windows.
 *
 * The scheduler uses the same `setInterval` pattern as
 * `reminderScheduler.ts` and supports graceful shutdown via `clearInterval`.
 * Configuration can be tuned through environment variables:
 *
 *   - `DISPUTE_DEADLINE_INTERVAL_MS` – tick interval (default 60 000 = 1 min)
 *   - `DISPUTE_INACTIVITY_TIMEOUT_MS` – inactivity timeout (default 30 d)
 *   - `DISPUTE_SENIOR_REVIEW_TIMEOUT_MS` – appeal timeout (default 14 d)
 *   - `DISPUTE_AUTO_RESOLVE_WINDOW_MS` – reversal window (default 24 h)
 *
 * The scheduler pulls the current dispute map via a getter function
 * so it stays decoupled from the route-layer storage internals.
 */

import { scanAndAutoResolve, type DisputeDeadlineServiceOptions } from "../services/disputeDeadlineService.js";
import type { Dispute } from "../types/dispute.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 60_000; // 1 minute

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _interval: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DisputeDeadlineSchedulerOptions extends DisputeDeadlineServiceOptions {
  /** Interval between scans in ms. Default 60 s. */
  pollIntervalMs?: number;
}

/**
 * Start the dispute deadline scheduler.
 *
 * @param getDisputes - A zero-argument function that returns the current list
 *   of disputes (e.g. `() => Array.from(disputesMap.values())`).
 * @param options     - Optional configuration overrides.
 */
export function startDisputeDeadlineScheduler(
  getDisputes: () => ReadonlyArray<Dispute>,
  options: DisputeDeadlineSchedulerOptions = {},
): void {
  if (_interval) {
    console.warn("[dispute-deadline] Scheduler already running; skipping duplicate start.");
    return;
  }

  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  console.log(
    `[dispute-deadline] Starting scheduler (interval=${pollIntervalMs}ms, ` +
    `inactivityTimeoutMs=${options.inactivityTimeoutMs ?? "default"}, ` +
    `seniorReviewTimeoutMs=${options.seniorReviewTimeoutMs ?? "default"})`,
  );

  _interval = setInterval(() => {
    try {
      const disputes = getDisputes();
      const result = scanAndAutoResolve(disputes, options);

      if (result.resolved.length > 0) {
        console.log(
          `[dispute-deadline] Resolved ${result.resolved.length} dispute(s):`,
          result.resolved.map((r) => `${r.disputeId} (${r.fromStatus}→${r.toStatus})`).join(", "),
        );
      }
    } catch (err) {
      console.error("[dispute-deadline] Scan error:", err);
    }
  }, pollIntervalMs);

  // Allow the process to exit even if the interval is still pending.
  if (_interval && typeof _interval === "object" && "unref" in _interval) {
    _interval.unref();
  }
}

/**
 * Stop the dispute deadline scheduler. Safe to call when not running.
 */
export function stopDisputeDeadlineScheduler(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    console.log("[dispute-deadline] Scheduler stopped.");
  }
}

/**
 * Whether the scheduler is currently active.
 */
export function isDisputeDeadlineSchedulerRunning(): boolean {
  return _interval !== null;
}

// ---------------------------------------------------------------------------
// Run-once convenience for integration tests or one-off scans
// ---------------------------------------------------------------------------

/**
 * Run a single scan cycle synchronously on the current dispute state.
 * Useful for integration tests that want to trigger the logic without
 * waiting for the interval timer.
 *
 * @param getDisputes - A zero-argument function returning the current dispute list.
 * @param options     - Optional configuration overrides.
 */
export function runDisputeDeadlineScanOnce(
  getDisputes: () => ReadonlyArray<Dispute>,
  options: DisputeDeadlineServiceOptions = {},
) {
  return scanAndAutoResolve(getDisputes(), options);
}
