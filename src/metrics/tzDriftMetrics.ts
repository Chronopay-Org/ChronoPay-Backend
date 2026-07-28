/**
 * Timezone Drift Monitor Metrics
 *
 * Tracks the results of the nightly timezone drift scan with tenant-scoped
 * counters and cardinality controls. Design mirrors slotMetrics.ts.
 *
 * Design decisions
 * ────────────────
 * - Severity levels are bounded (critical, warning, info) — no unbounded
 *   label dimensions.
 * - Tenant IDs are budgeted to prevent metric cardinality explosion.
 *   Overflowing tenants are relabeled as __overflow__.
 * - A gauge stores the last successful scan timestamp for alerting on
 *   stale runs.
 * - All state is reset-table for test isolation.
 */

export type TzDriftSeverity = "critical" | "warning" | "info";

type TzDriftMetricName = "tz_drift_ambiguous_slots" | "tz_drift_missing_tz_slots";

const OVERFLOW_LABEL_VALUE = "__overflow__";

export interface TzDriftMetricsSnapshot {
  /** Count of ambiguous slots by tenant+severity key */
  ambiguousCounts: Record<string, number>;
  /** Count of slots with missing TZ info by tenant+severity key */
  missingTzCounts: Record<string, number>;
  /** Timestamp of the last completed scan (epoch ms), or 0 if never scanned */
  lastScanTimestampMs: number;
  /** Total slots scanned since last reset */
  totalScanned: number;
  /** Offenders relabeled because a metric exceeded its label budget */
  cardinalityOverflowCounts: Record<TzDriftMetricName, number>;
}

// ─── Internal state ───────────────────────────────────────────────────────────

const _ambiguousCounts: Record<string, number> = {};
const _ambiguousTuples = new Map<string, string>();
const _missingTzCounts: Record<string, number> = {};
const _missingTzTuples = new Map<string, string>();
let _lastScanTimestampMs = 0;
let _totalScanned = 0;
const _cardinalityOverflowCounts: Record<TzDriftMetricName, number> = {
  tz_drift_ambiguous_slots: 0,
  tz_drift_missing_tz_slots: 0,
};

const TZ_DRIFT_METRIC_BUDGETS: Record<TzDriftMetricName, number> = {
  tz_drift_ambiguous_slots: 32,
  tz_drift_missing_tz_slots: 32,
};

function boundedTuple(
  metric: TzDriftMetricName,
  tuples: Map<string, string>,
  key: string,
): string {
  if (tuples.has(key)) {
    const value = tuples.get(key)!;
    tuples.delete(key);
    tuples.set(key, value);
    return key;
  }

  if (tuples.size < TZ_DRIFT_METRIC_BUDGETS[metric]) {
    tuples.set(key, key);
    return key;
  }

  _cardinalityOverflowCounts[metric] += 1;
  return OVERFLOW_LABEL_VALUE;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record ambiguous slots for a tenant+severity combination.
 *
 * @param tenantId - The tenant identifier (e.g. professional_id).
 * @param severity - critical, warning, or info.
 * @param count    - Number of ambiguous slots found.
 */
export function recordAmbiguousSlots(
  tenantId: string,
  severity: TzDriftSeverity,
  count: number,
): void {
  if (!Number.isFinite(count) || count < 0) return;
  const key = boundedTuple(
    "tz_drift_ambiguous_slots",
    _ambiguousTuples,
    `${tenantId}_${severity}`,
  );
  _ambiguousCounts[key] = (_ambiguousCounts[key] ?? 0) + count;
}

/**
 * Record slots with missing timezone info for a tenant+severity combination.
 *
 * @param tenantId - The tenant identifier.
 * @param severity - critical, warning, or info.
 * @param count    - Number of slots with missing TZ info.
 */
export function recordMissingTzSlots(
  tenantId: string,
  severity: TzDriftSeverity,
  count: number,
): void {
  if (!Number.isFinite(count) || count < 0) return;
  const key = boundedTuple(
    "tz_drift_missing_tz_slots",
    _missingTzTuples,
    `${tenantId}_${severity}`,
  );
  _missingTzCounts[key] = (_missingTzCounts[key] ?? 0) + count;
}

/**
 * Update the last successful scan timestamp.
 *
 * @param timestampMs - Epoch ms of the scan completion.
 */
export function recordScanCompleted(timestampMs: number): void {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return;
  _lastScanTimestampMs = timestampMs;
}

/**
 * Increment the total number of slots scanned.
 *
 * @param count - Number of slots scanned in this sweep.
 */
export function recordSlotsScanned(count: number): void {
  if (!Number.isFinite(count) || count < 0) return;
  _totalScanned += count;
}

/**
 * Return a snapshot of all current TZ drift metric values.
 * Safe to call from tests without side effects.
 */
export function getTzDriftMetricsSnapshot(): TzDriftMetricsSnapshot {
  return {
    ambiguousCounts: { ..._ambiguousCounts },
    missingTzCounts: { ..._missingTzCounts },
    lastScanTimestampMs: _lastScanTimestampMs,
    totalScanned: _totalScanned,
    cardinalityOverflowCounts: { ..._cardinalityOverflowCounts },
  };
}

/**
 * Reset all metrics to zero.
 * Intended for test isolation — do not call in production code.
 */
export function resetTzDriftMetrics(): void {
  for (const key of Object.keys(_ambiguousCounts)) {
    delete _ambiguousCounts[key];
  }
  _ambiguousTuples.clear();
  for (const key of Object.keys(_missingTzCounts)) {
    delete _missingTzCounts[key];
  }
  _missingTzTuples.clear();
  _lastScanTimestampMs = 0;
  _totalScanned = 0;
  _cardinalityOverflowCounts.tz_drift_ambiguous_slots = 0;
  _cardinalityOverflowCounts.tz_drift_missing_tz_slots = 0;
}
