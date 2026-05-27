/**
 * Slot service metrics — counters and histograms with strict cardinality controls.
 *
 * Design decisions
 * ────────────────
 * - No unbounded label dimensions (no user IDs, no raw route params).
 * - Labels are limited to a fixed set of known values: operation, outcome,
 *   and cache_status.
 * - The registry is a plain singleton object so tests can reset it without
 *   needing a metrics library.
 * - Histogram buckets are pre-defined; no dynamic bucket creation.
 */

export type SlotOperation = "list" | "create" | "update" | "delete";
export type SlotOutcome = "success" | "error";
export type CacheStatus = "hit" | "miss" | "bypass";

export interface SlotMetricsSnapshot {
  /** Total slot operation invocations keyed by operation+outcome */
  operationCounts: Record<string, number>;
  /** Histogram bucket counts for list latency in milliseconds */
  listLatencyBuckets: Record<number, number>;
  listLatencyCount: number;
  listLatencySum: number;
  /** Cache hit/miss/bypass counts */
  cacheCounts: Record<CacheStatus, number>;
}

// ─── Histogram buckets (ms) ───────────────────────────────────────────────────
const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

// ─── Internal state ───────────────────────────────────────────────────────────

const _operationCounts: Record<string, number> = {};
const _listLatencyBuckets: Record<number, number> = {};
let _listLatencyCount = 0;
let _listLatencySum = 0;
const _cacheCounts: Record<CacheStatus, number> = {
  hit: 0,
  miss: 0,
  bypass: 0,
};

// Initialise histogram buckets to zero
for (const b of LATENCY_BUCKETS_MS) {
  _listLatencyBuckets[b] = 0;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Increment the counter for a slot operation outcome.
 *
 * @param operation - One of the fixed SlotOperation values.
 * @param outcome   - "success" or "error".
 */
export function recordSlotOperation(
  operation: SlotOperation,
  outcome: SlotOutcome,
): void {
  const key = `${operation}_${outcome}`;
  _operationCounts[key] = (_operationCounts[key] ?? 0) + 1;
}

/**
 * Record the latency of a list-slots call in milliseconds.
 *
 * @param durationMs - Elapsed time in milliseconds (non-negative).
 */
export function recordListLatency(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;

  _listLatencyCount += 1;
  _listLatencySum += durationMs;

  for (const bucket of LATENCY_BUCKETS_MS) {
    if (durationMs <= bucket) {
      _listLatencyBuckets[bucket] += 1;
    }
  }
}

/**
 * Record a cache interaction for the slot list.
 *
 * @param status - "hit", "miss", or "bypass" (Redis unavailable).
 */
export function recordCacheStatus(status: CacheStatus): void {
  _cacheCounts[status] += 1;
}

/**
 * Return a snapshot of all current metric values.
 * Safe to call from tests without side effects.
 */
export function getSlotMetricsSnapshot(): SlotMetricsSnapshot {
  return {
    operationCounts: { ..._operationCounts },
    listLatencyBuckets: { ..._listLatencyBuckets },
    listLatencyCount: _listLatencyCount,
    listLatencySum: _listLatencySum,
    cacheCounts: { ..._cacheCounts },
  };
}

/**
 * Reset all metrics to zero.
 * Intended for test isolation — do not call in production code.
 */
export function resetSlotMetrics(): void {
  for (const key of Object.keys(_operationCounts)) {
    delete _operationCounts[key];
  }
  for (const b of LATENCY_BUCKETS_MS) {
    _listLatencyBuckets[b] = 0;
  }
  _listLatencyCount = 0;
  _listLatencySum = 0;
  _cacheCounts.hit = 0;
  _cacheCounts.miss = 0;
  _cacheCounts.bypass = 0;
}
