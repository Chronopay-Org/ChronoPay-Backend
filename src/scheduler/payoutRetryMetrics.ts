/**
 * Payout Retry Metrics
 * --------------------
 *
 * Prometheus metrics and application-level rollup counters for the payout
 * retry backoff subsystem.
 *
 * Design mirrors escrowMetrics.ts:
 *  - Prom-client metrics use the cardinality-budget factory from src/metrics.ts.
 *  - Label values are restricted to a fixed, controlled vocabulary (provider id,
 *    outcome) so no user-supplied strings can blow up cardinality.
 *  - Rollup counters shadow the prom counters for unit-test assertions, which
 *    do not exercise the prom-client registry.  Reset them in `beforeEach`.
 *
 * Emitted metrics:
 *
 *  payout_retry_attempts_total{provider_id, outcome}
 *    Incremented on every retry attempt.  `outcome` is one of:
 *      "scheduled"   – delay was computed and the retry will fire
 *      "exhausted"   – maxRetries reached; payout moves to DLQ / quarantine
 *      "ceiling_hit" – computed cap was clamped to maxDelayCeilingMs
 *
 *  payout_retry_delay_ms{provider_id}
 *    Histogram of the actual jittered delay value in milliseconds.
 *    Feeds alerting on mean wait time per provider.
 *
 *  payout_retry_cap_ms{provider_id}
 *    Histogram of the pre-jitter cap (= min(ceiling, base * mult^attempt)).
 *    Useful for verifying the ceiling is being applied correctly.
 */

import {
  createBudgetedCounter,
  createBudgetedHistogram,
  register,
} from "../metrics.js";

// ─── Provider-id cardinality budget ──────────────────────────────────────────

/**
 * Maximum number of distinct provider ids tracked before overflowing into the
 * `__overflow__` label bucket.  Increase if you add more rails.
 */
export const PAYOUT_RETRY_PROVIDER_BUDGET = 16;

// ─── Prometheus metrics ───────────────────────────────────────────────────────

/**
 * Total retry attempts broken down by provider and outcome.
 * outcome ∈ { "scheduled", "exhausted", "ceiling_hit" }
 */
export const payoutRetryAttemptsTotal = createBudgetedCounter({
  name: "payout_retry_attempts_total",
  help: "Total payout retry attempts broken down by provider id and outcome",
  labels: ["provider_id", "outcome"],
  // 16 providers × 3 outcomes + headroom
  budget: PAYOUT_RETRY_PROVIDER_BUDGET * 4,
  registers: [register],
});

/**
 * Histogram of the final jittered delay (ms) per provider.
 * Buckets cover sub-second through ~2-minute waits.
 */
export const payoutRetryDelayMs = createBudgetedHistogram({
  name: "payout_retry_delay_ms",
  help: "Jittered retry delay in milliseconds per payout provider",
  labels: ["provider_id"],
  budget: PAYOUT_RETRY_PROVIDER_BUDGET,
  buckets: [0, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000],
  registers: [register],
});

/**
 * Histogram of the pre-jitter cap (ms) per provider.
 * Allows operators to verify the ceiling is actively clamping.
 */
export const payoutRetryCapMs = createBudgetedHistogram({
  name: "payout_retry_cap_ms",
  help: "Pre-jitter exponential backoff cap in milliseconds per payout provider",
  labels: ["provider_id"],
  budget: PAYOUT_RETRY_PROVIDER_BUDGET,
  buckets: [0, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000],
  registers: [register],
});

// ─── Application-level rollup counters (for unit tests) ───────────────────────

export type PayoutRetryOutcome = "scheduled" | "exhausted" | "ceiling_hit";

interface PayoutRetryRollupCounters {
  /** Total attempts recorded via recordRetryAttempt(). */
  attempts: number;
  /** Subset where outcome === "scheduled". */
  scheduled: number;
  /** Subset where outcome === "exhausted". */
  exhausted: number;
  /** Subset where attempts had their cap clamped to the provider ceiling. */
  ceilingHits: number;
}

const _rollup: PayoutRetryRollupCounters = {
  attempts: 0,
  scheduled: 0,
  exhausted: 0,
  ceilingHits: 0,
};

export const payoutRetryRollup = {
  /**
   * Record a single retry attempt.
   *
   * @param providerId   Provider identifier (e.g. "ach", "stellar").
   * @param outcome      Whether the retry was scheduled, exhausted, or ceiling-clamped.
   * @param delayMs      The final jittered delay in milliseconds.
   * @param capMs        The pre-jitter cap in milliseconds.
   */
  recordAttempt(
    providerId: string,
    outcome: PayoutRetryOutcome,
    delayMs: number,
    capMs: number,
  ): void {
    _rollup.attempts += 1;

    switch (outcome) {
      case "scheduled":
        _rollup.scheduled += 1;
        break;
      case "exhausted":
        _rollup.exhausted += 1;
        break;
      case "ceiling_hit":
        _rollup.ceilingHits += 1;
        break;
    }

    // Prom-client counters / histograms (no-op in test environments because
    // prom-client itself is still importable but collectDefaultMetrics is skipped).
    payoutRetryAttemptsTotal.labels(providerId, outcome).inc();
    payoutRetryDelayMs.labels(providerId).observe(delayMs);
    payoutRetryCapMs.labels(providerId).observe(capMs);
  },

  /** Return a frozen snapshot of the current counters. */
  snapshot(): Readonly<PayoutRetryRollupCounters> {
    return { ..._rollup };
  },

  /** Reset all counters.  Call this in `beforeEach` within test suites. */
  reset(): void {
    _rollup.attempts = 0;
    _rollup.scheduled = 0;
    _rollup.exhausted = 0;
    _rollup.ceilingHits = 0;
  },
};

// ─── Convenience helpers ──────────────────────────────────────────────────────

/**
 * Determine the `PayoutRetryOutcome` from a backoff result and whether the
 * retry budget is exhausted.  Centralises the decision so callers don't need
 * to re-implement it.
 *
 * @param capMs             Pre-jitter cap returned by calculatePayoutBackoffDelay.
 * @param maxDelayCeilingMs Provider's configured ceiling.
 * @param isExhausted       True when no more retries remain.
 */
export function resolveRetryOutcome(
  capMs: number,
  maxDelayCeilingMs: number,
  isExhausted: boolean,
): PayoutRetryOutcome {
  if (isExhausted) return "exhausted";
  // ceiling_hit when the exponential growth would have exceeded the ceiling
  // (i.e. cap was clamped — capMs equals the ceiling value).
  if (capMs === maxDelayCeilingMs) return "ceiling_hit";
  return "scheduled";
}
