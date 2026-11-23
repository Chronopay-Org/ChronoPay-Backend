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
type SlotMetricName = "slot_operation_count" | "slot_cache_status";

const OVERFLOW_LABEL_VALUE = "__overflow__";

export interface SlotMetricsSnapshot {
  /** Total slot operation invocations keyed by operation+outcome */
  operationCounts: Record<string, number>;
  /** Histogram bucket counts for list latency in milliseconds */
  listLatencyBuckets: Record<number, number>;
  listLatencyCount: number;
  listLatencySum: number;
  /** Cache hit/miss/bypass counts */
  cacheCounts: Record<string, number>;
  /** Offenders relabeled because a slot metric exceeded its label budget */
  cardinalityOverflowCounts: Record<SlotMetricName, number>;
}

// ─── Histogram buckets (ms) ───────────────────────────────────────────────────
const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

// ─── Internal state ───────────────────────────────────────────────────────────

const _operationCounts: Record<string, number> = {};
const _operationTuples = new Map<string, string>();
const _listLatencyBuckets: Record<number, number> = {};
let _listLatencyCount = 0;
let _listLatencySum = 0;
const _cacheCounts: Record<string, number> = {
  hit: 0,
  miss: 0,
  bypass: 0,
};
const _cacheTuples = new Map<string, string>();
const _cardinalityOverflowCounts: Record<SlotMetricName, number> = {
  slot_operation_count: 0,
  slot_cache_status: 0,
};

const SLOT_METRIC_BUDGETS: Record<SlotMetricName, number> = {
  slot_operation_count: 8,
  slot_cache_status: 3,
};

function boundedTuple(
  metric: SlotMetricName,
  tuples: Map<string, string>,
  key: string,
): string {
  if (tuples.has(key)) {
    const value = tuples.get(key)!;
    tuples.delete(key);
    tuples.set(key, value);
    return key;
  }

  if (tuples.size < SLOT_METRIC_BUDGETS[metric]) {
    tuples.set(key, key);
    return key;
  }

  _cardinalityOverflowCounts[metric] += 1;
  return OVERFLOW_LABEL_VALUE;
}

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
  const key = boundedTuple(
    "slot_operation_count",
    _operationTuples,
    `${operation}_${outcome}`,
  );
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
  const key = boundedTuple("slot_cache_status", _cacheTuples, status);
  _cacheCounts[key] = (_cacheCounts[key] ?? 0) + 1;
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
    cardinalityOverflowCounts: { ..._cardinalityOverflowCounts },
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
  _operationTuples.clear();
  for (const b of LATENCY_BUCKETS_MS) {
    _listLatencyBuckets[b] = 0;
  }
  _listLatencyCount = 0;
  _listLatencySum = 0;
  _cacheCounts.hit = 0;
  _cacheCounts.miss = 0;
  _cacheCounts.bypass = 0;
  delete _cacheCounts[OVERFLOW_LABEL_VALUE];
  _cacheTuples.clear();
  _cardinalityOverflowCounts.slot_operation_count = 0;
  _cardinalityOverflowCounts.slot_cache_status = 0;
}
