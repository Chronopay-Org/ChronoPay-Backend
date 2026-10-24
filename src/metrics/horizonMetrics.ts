// @ts-nocheck
/**
 * Horizon rate-limit and request-queue metrics.
 *
 * Emits two gauges per Horizon host:
 *   - horizon_rate_limit_remaining   — tokens remaining in the current window
 *                                      (read from X-RateLimit-Remaining header)
 *   - horizon_request_queue_depth    — number of in-flight / queued requests
 *                                      waiting for the token-bucket to refill
 *
 * Design decisions
 * ────────────────
 * - One label dimension: `host` (the base URL, e.g. "https://horizon.stellar.org").
 *   No user IDs, path fragments, or other unbounded labels.
 * - Budget of 32 covers realistic multi-host deployments while keeping
 *   cardinality bounded.
 * - Uses the central createBudgetedGauge factory from src/metrics.ts so the
 *   values automatically participate in the shared Prometheus registry and
 *   cardinality overflow tracking.
 */

import { createBudgetedGauge } from "../metrics.js";

/**
 * Current remaining request quota reported by the Horizon host.
 *
 * Updated after every successful response that includes an
 * `X-RateLimit-Remaining` header.  Stays at the last known value between
 * responses — a flat-line in the gauge means no new information was received.
 *
 * Label: `host` — the base URL of the Horizon node, e.g.
 *   `"https://horizon-testnet.stellar.org"`
 */
export const horizonRateLimitRemaining = createBudgetedGauge({
  name: "horizon_rate_limit_remaining",
  help: "Remaining requests in the current Horizon rate-limit window (from X-RateLimit-Remaining header)",
  labels: ["host"],
  budget: 32,
});

/**
 * Current depth of the per-host request queue.
 *
 * Incremented when a request enters the token-bucket queue because the
 * bucket is empty, and decremented once the request is dequeued and
 * executed.  A sustained high value indicates the Horizon host is
 * severely throttled.
 *
 * Label: `host` — same as horizonRateLimitRemaining.
 */
export const horizonRequestQueueDepth = createBudgetedGauge({
  name: "horizon_request_queue_depth",
  help: "Number of requests currently queued waiting for the Horizon token-bucket to refill",
  labels: ["host"],
  budget: 32,
});

/**
 * Helper — record a fresh `X-RateLimit-Remaining` observation.
 *
 * @param host      Base URL of the Horizon node.
 * @param remaining Remaining request quota (must be >= 0).
 */
export function recordRateLimitRemaining(host: string, remaining: number): void {
  if (!host || !Number.isFinite(remaining) || remaining < 0) return;
  horizonRateLimitRemaining.labels(host).set(remaining);
}

/**
 * Helper — record the current queue depth for a host.
 *
 * @param host  Base URL of the Horizon node.
 * @param depth Non-negative queue depth.
 */
export function recordQueueDepth(host: string, depth: number): void {
  if (!host || !Number.isFinite(depth) || depth < 0) return;
  horizonRequestQueueDepth.labels(host).set(depth);
}

/**
 * Reset both gauges for a specific host back to zero.
 * Intended for test isolation — do not call in production code.
 */
export function resetHorizonMetricsForHost(host: string): void {
  horizonRateLimitRemaining.labels(host).set(0);
  horizonRequestQueueDepth.labels(host).set(0);
}
