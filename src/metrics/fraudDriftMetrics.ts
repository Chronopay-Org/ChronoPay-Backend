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
 * versions are dropped with a warning so a misbehaving deploy cannot blow up
 * cardinality or memory usage.
 */

import {
  canonicalizeCounts,
  emptyHistogram,
  SCORE_BINS,
  scoreToBin,
  type HistogramCounts,
  type HistogramInput,
} from "../services/fraudDriftMath.js";
import { logger } from "../utils/logger.js";

const OVERFLOW_VERSION_KEY = "__overflow__";
const MAX_MODEL_VERSIONS = 8;

/** Highest score fed into the bin index; scores above this land in "9+". */
const MAX_SCORE = SCORE_BINS.length - 1;

/**
 * Internal live (incoming) score histogram per model version.
 * We do not prune automatically; the detector resets state per model swap.
 */
const _liveCounts: Record<string, HistogramCounts> = Object.create(null);

/** Internal baseline (training) score histogram per model version. */
const _baselineCounts: Record<string, HistogramCounts> = Object.create(null);

/** True once at least one model version was rejected by the cardinality cap. */
let _overflowed = false;

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
  /** True if at least one model version was rejected by the cardinality cap. */
  overflowed: boolean;
}

/** Number of distinct versions currently present in either state map. */
function trackedVersionCount(): number {
  return new Set([
    ...Object.keys(_liveCounts),
    ...Object.keys(_baselineCounts),
  ]).size;
}

/**
 * Resolve the bounded key for a model version. Returns `null` when the
 * cardinality budget is already exhausted and this is a new version, in which
 * case the caller must drop the observation/baseline.
 */
function boundedKey(version: string, warnOnOverflow = true): string | null {
  // Treat empty / null-style values as a single sentinel so callers can't
  // accidentally create a separate bucket for each unique label value.
  const key = !version || typeof version !== "string" ? "__none__" : version;
  if (_liveCounts[key] !== undefined || _baselineCounts[key] !== undefined) {
    return key;
  }
  if (trackedVersionCount() < MAX_MODEL_VERSIONS) {
    return key;
  }
  if (warnOnOverflow) {
    _overflowed = true;
    logger.warn(
      {
        code: "FRAUD_DRIFT_MODEL_VERSION_LIMIT",
        modelVersion: key,
        limit: MAX_MODEL_VERSIONS,
      },
      "fraud drift model version limit reached; dropping new model version",
    );
  }
  return null;
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

/**
 * Increment the live histogram for one observed fraud score.
 *
 * Non-finite scores (NaN, ±Infinity) are ignored so they cannot corrupt the
 * histogram. Finite scores are clamped into the bucket domain before binning.
 *
 * @param modelVersion identifier of the deployed scoring model
 * @param score        raw fraud score value (will be binned)
 */
export function recordFraudScore(modelVersion: string, score: number): void {
  if (!Number.isFinite(score)) return;
  const clamped = Math.min(MAX_SCORE, Math.max(0, score));
  const version = boundedKey(modelVersion);
  if (version === null) return;
  const live = ensureLive(version);
  const bin = scoreToBin(clamped);
  live[bin] += 1;
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
export function setFraudScoreBaseline(
  modelVersion: string,
  histogram: HistogramInput,
): void {
  if (histogram == null || typeof histogram !== "object") return;
  const version = boundedKey(modelVersion);
  if (version === null) return;
  const canonical = canonicalizeCounts(histogram);
  _baselineCounts[version] = canonical;
  _baselineTotals[version] = Object.values(canonical).reduce((a, b) => a + b, 0);
}

/** Drop the baseline for one version (e.g. on training refresh). */
export function clearBaseline(modelVersion: string): void {
  const version = boundedKey(modelVersion, false);
  if (version === null) return;
  delete _baselineCounts[version];
  delete _baselineTotals[version];
}

/**
 * Drop ALL state for the given model version. Called on model swaps so the
 * next drift check starts again from an empty baseline window.
 */
export function clearFraudDriftState(modelVersion: string): void {
  const version = boundedKey(modelVersion, false);
  if (version === null) return;
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
    overflowed: _overflowed,
  };
}

/** Reset all state — test isolation only. Do not call in production code. */
export function resetFraudDriftState(): void {
  for (const k of Object.keys(_liveCounts)) delete _liveCounts[k];
  for (const k of Object.keys(_baselineCounts)) delete _baselineCounts[k];
  for (const k of Object.keys(_observationTotals)) delete _observationTotals[k];
  for (const k of Object.keys(_baselineTotals)) delete _baselineTotals[k];
  _overflowed = false;
}

/** Configuration constants exported for tests / docs. */
export const FRAUD_DRIFT_LIMITS = {
  MAX_MODEL_VERSIONS,
  OVERFLOW_VERSION_KEY,
  SCORE_BINS,
};
