/**
 * fraudDriftMetrics.ts
 * --------------------
 * Singleton histogram state for the fraud drift detector.
 *
 * Mirrors the cardinality-bounded pattern used by `src/metrics/slotMetrics.ts`:
 *   - one plain object per metric
 *   - no user-controlled keys
 *   - explicit `getSnapshot()` + `reset()` for test isolation
 *
 * The histogram is per "model version" because fraud scoring rules change
 * over time; each version should be evaluated against its own baseline.
 * Model versions are bounded (default cap = 8). Once exceeded, additional
 * versions are merged under the synthetic key "__overflow__" so a misbehaving
 * deploy cannot blow up cardinality.
 */

import { canonicalizeCounts, emptyHistogram, SCORE_BINS, scoreToBin } from "../services/fraudDriftMath.js";
import type { HistogramCounts } from "../services/fraudDriftMath.js";

const OVERFLOW_VERSION_KEY = "__overflow__";
const MAX_MODEL_VERSIONS = 8;

/**
 * Internal live (incoming) score histogram per model version.
 * We do not prune automatically; the detector resets state per model swap.
 */
const _liveCounts: Record<string, HistogramCounts> = Object.create(null);

/** Internal baseline (training) score histogram per model version. */
const _baselineCounts: Record<string, HistogramCounts> = Object.create(null);

/** Set of model-version keys that have overflowed the budget. */
const _overflowVersions = new Set<string>();

/** Total score observations seen per version (used for minimum-sample guards). */
const _observationTotals: Record<string, number> = Object.create(null);

/** Total baseline samples stored per version. */
const _baselineTotals: Record<string, number> = Object.create(null);

export interface FraudDriftSnapshot {
  /** Bounded list of model version keys currently tracked. */
  versions: string[];
  /** Live score histograms keyed by model version. */
  live: Record<string, HistogramCounts>;
  /** Baseline histograms keyed by model version. */
  baseline: Record<string, HistogramCounts>;
  /** Total live observations seen per model version (post-canonicalisation). */
  liveTotals: Record<string, number>;
  /** Total baseline samples stored per model version. */
  baselineTotals: Record<string, number>;
  /** True if at least one model version was relabelled to overflow. */
  overflowed: boolean;
}

function boundedKey(version: string): string {
  // Treat empty / null-style values as a single sentinel so callers can't
  // accidentally create a separate bucket for each unique label value.
  if (!version || typeof version !== "string") return "__none__";
  if (_liveCounts[version] !== undefined || _baselineCounts[version] !== undefined) {
    return version;
  }
  const known = Object.keys(_liveCounts).length;
  if (known < MAX_MODEL_VERSIONS) {
    return version;
  }
  _overflowVersions.add(version);
  return OVERFLOW_VERSION_KEY;
}

function ensureLive(version: string): HistogramCounts {
  let h = _liveCounts[version];
  if (!h) {
    h = emptyHistogram();
    _liveCounts[version] = h;
    _observationTotals[version] = 0;
  }
  return h;
}

function ensureBaseline(version: string): HistogramCounts {
  let h = _baselineCounts[version];
  if (!h) {
    h = emptyHistogram();
    _baselineCounts[version] = h;
    _baselineTotals[version] = 0;
  }
  return h;
}

/**
 * Increment the live histogram for one observed fraud score.
 *
 * @param modelVersion identifier of the deployed scoring model
 * @param score        raw fraud score value (will be binned)
 */
export function recordFraudScore(modelVersion: string, score: number): void {
  const version = boundedKey(modelVersion);
  const live = ensureLive(version);
  const bin = scoreToBin(score);
  live[bin] = (live[bin] ?? 0) + 1;
  _observationTotals[version] = (_observationTotals[version] ?? 0) + 1;
}

/**
 * Replace the baseline histogram for the given model version. Subsequent
 * drift checks will compare the rolling live histogram against this baseline
 * until {@link clearBaseline} or {@link resetFraudDriftState} is called.
 *
 * The histogram is canonicalised: unknown keys collapse into the overflow
 * bin "9+" and non-positive counts are dropped.
 */
export function setFraudScoreBaseline(modelVersion: string, histogram: HistogramCounts): void {
  const version = boundedKey(modelVersion);
  const canonical = canonicalizeCounts(histogram);
  _baselineCounts[version] = canonical;
  _baselineTotals[version] = Object.values(canonical).reduce((a, b) => a + b, 0);
}

/** Drop the baseline for one version (e.g. on training refresh). */
export function clearBaseline(modelVersion: string): void {
  const version = boundedKey(modelVersion);
  delete _baselineCounts[version];
  delete _baselineTotals[version];
}

/**
 * Drop ALL state for the given model version. Called on model swaps so the
 * next drift check starts again from an empty baseline window.
 */
export function clearFraudDriftState(modelVersion: string): void {
  const version = boundedKey(modelVersion);
  delete _liveCounts[version];
  delete _baselineCounts[version];
  delete _observationTotals[version];
  delete _baselineTotals[version];
}

/** Snapshot all current histogram state for the detector and tests. */
export function getFraudDriftSnapshot(): FraudDriftSnapshot {
  const live: Record<string, HistogramCounts> = Object.create(null);
  const baseline: Record<string, HistogramCounts> = Object.create(null);
  for (const v of Object.keys(_liveCounts)) {
    const l = _liveCounts[v];
    live[v] = { ...l };
  }
  for (const v of Object.keys(_baselineCounts)) {
    const b = _baselineCounts[v];
    baseline[v] = { ...b };
  }
  const versions = Array.from(
    new Set([...Object.keys(_liveCounts), ...Object.keys(_baselineCounts)]),
  ).sort();
  return {
    versions,
    live,
    baseline,
    liveTotals: { ..._observationTotals },
    baselineTotals: { ..._baselineTotals },
    overflowed: _overflowVersions.size > 0,
  };
}

/** Reset all state — test isolation only. Do not call in production code. */
export function resetFraudDriftState(): void {
  for (const k of Object.keys(_liveCounts)) delete _liveCounts[k];
  for (const k of Object.keys(_baselineCounts)) delete _baselineCounts[k];
  for (const k of Object.keys(_observationTotals)) delete _observationTotals[k];
  for (const k of Object.keys(_baselineTotals)) delete _baselineTotals[k];
  _overflowVersions.clear();
}

/** Configuration constants exported for tests / docs. */
export const FRAUD_DRIFT_LIMITS = {
  MAX_MODEL_VERSIONS,
  OVERFLOW_VERSION_KEY,
  SCORE_BINS,
};
