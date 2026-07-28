/**
 * fraudDriftMath.ts
 * -----------------
 * Pure statistical primitives for the fraud score drift detector.
 *
 * Two drift statistics are implemented:
 *   - Population Stability Index (PSI): Σᵢ (pᵢ − qᵢ) · ln(pᵢ / qᵢ)
 *   - Kullback–Leibler divergence in nats: Σᵢ pᵢ · ln(pᵢ / qᵢ)
 *
 * Both formulas require p, q ≥ 0 and Σp = Σq = 1. When the input is raw
 * count vectors (always non-negative, integer with sparse zeros), we first
 * normalize via {@link normalizeToDistribution} which applies Laplace ε
 * smoothing so PSI/KL are defined even when one side has zero mass in a bin.
 *
 * Smoothing distributes a tiny ε symmetrically: each bin receives +ε, then
 * the vector is scaled back to sum to 1. The resulting behavior is:
 *   - empty histograms return a smoothed uniform distribution, so PSI/KL still
 *     compute and yield finite numbers
 *   - sparse bumps yield small but non-NaN PSI/KL
 *   - for large N the smooth is negligible relative to observed counts
 *
 * No I/O. No module-level state. Fully unit-testable in isolation.
 */

export const SCORE_BINS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9+"] as const;
export type ScoreBin = (typeof SCORE_BINS)[number];

/** Default Laplace smoothing constant used for PSI/KL. */
export const DEFAULT_EPSILON = 1e-6;

/**
 * Default thresholds modeled on industry PSI conventions:
 *   - PSI < 0.1  ⇒ no meaningful drift
 *   - PSI 0.1–0.2 ⇒ moderate drift (warning)
 *   - PSI ≥ 0.2  ⇒ significant drift (critical)
 *
 * KL is more sensitive; defaults are calibrated to match the PSI bands
 * for the same empirical histograms.
 */
export interface DriftThresholds {
  psiWarning: number;
  psiCritical: number;
  klWarning: number;
  klCritical: number;
}

export const DEFAULT_THRESHOLDS: DriftThresholds = {
  psiWarning: 0.1,
  psiCritical: 0.2,
  klWarning: 0.05,
  klCritical: 0.1,
};

export type DriftSeverity = "ok" | "warning" | "critical";

export interface HistogramCounts {
  [bin: string]: number;
}

export interface Distribution {
  /** Mass per bin keyed by bin identifier. Sums to 1 (within ULP error). */
  mass: Record<string, number>;
  /** Total counts prior to smoothing. */
  total: number;
}

export interface DriftStatisticResult {
  value: number;
  severity: DriftSeverity;
}

/** Round a numeric fraud score into one of the canonical bins. */
export function scoreToBin(score: number): ScoreBin {
  if (!Number.isFinite(score) || score < 0) return "0";
  const intScore = Math.floor(score);
  if (intScore >= 9) return "9+";
  // The index of SCORE_BINS follows the integer score (0–8).
  return SCORE_BINS[intScore] ?? "0";
}

/** Empty counts object keyed by every canonical bin. */
export function emptyHistogram(): HistogramCounts {
  const out: HistogramCounts = {};
  for (const b of SCORE_BINS) out[b] = 0;
  return out;
}

/**
 * Aggregate any count map into the canonical bin set, clamping unknown keys
 * into the "9+" overflow bin. Non-finite or negative counts are dropped.
 */
export function canonicalizeCounts(raw: HistogramCounts): HistogramCounts {
  const out = emptyHistogram();
  for (const [k, v] of Object.entries(raw)) {
    if (!Number.isFinite(v) || v <= 0) continue;
    const bin = SCORE_BINS.includes(k as ScoreBin) ? (k as ScoreBin) : "9+";
    out[bin] += v;
  }
  return out;
}

/**
 * Return the sorted union of bin keys across the two histograms; used by
 * downstream callers that want a stable iteration order for diffs/logs.
 */
export function alignmentKeys(a: HistogramCounts, b: HistogramCounts): string[] {
  const set = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  return Array.from(set).sort();
}

/**
 * Normalize integer counts into a probability distribution with ε smoothing.
 *
 *   mass_i = (count_i + ε) / (Σcount + K · ε)
 *
 * Returns null when the histogram is non-finite or both total and ε are 0 so
 * callers can distinguish "empty" from "degenerate".
 */
export function normalizeToDistribution(
  counts: HistogramCounts,
  epsilon: number = DEFAULT_EPSILON,
): Distribution | null {
  if (!Number.isFinite(epsilon) || epsilon < 0) return null;
  // `typeof null === "object"` so we must explicitly reject null here;
  // otherwise `Object.keys(counts)` below would throw a TypeError.
  if (counts == null || typeof counts !== "object") return null;
  const bins = alignmentKeys(counts, emptyHistogram());
  let total = 0;
  const safe: Record<string, number> = {};
  for (const bin of bins) {
    const raw = counts[bin];
    // Reject any non-finite or negative input rather than silently coerce:
    // a malformed baseline must not silently become "all zeros".
    if (
      raw !== undefined &&
      (!Number.isFinite(raw as number) || (raw as number) < 0)
    ) {
      return null;
    }
    const v = (raw as number) ?? 0;
    safe[bin] = v;
    if (v > 0) total += v;
  }
  // Empty histogram => smoothed uniform distribution.
  const k = bins.length;
  const denominator = total + k * epsilon;
  if (denominator <= 0) return null;
  const mass: Record<string, number> = {};
  for (const bin of bins) {
    mass[bin] = (safe[bin] + epsilon) / denominator;
  }
  // `obsTotal` is the real count, used to flag "really empty" inputs upstream.
  return { mass, total };
}

/**
 * Population Stability Index between expected (baseline) and actual (live)
 * distributions. Both arguments MUST be normalized via
 * {@link normalizeToDistribution}. Result is finite non-negative when
 * smoothing is applied; NaN only when both inputs are unsmoothed raw 0s.
 */
export function populationStabilityIndex(
  expected: Distribution,
  actual: Distribution,
): number {
  if (!expected || !actual || !expected.mass || !actual.mass) return NaN;
  const keys = alignmentKeys(expected.mass, actual.mass);
  let sum = 0;
  let observed = 0;
  for (const k of keys) {
    const p = expected.mass[k] ?? 0;
    const q = actual.mass[k] ?? 0;
    if (p <= 0 || q <= 0) continue;
    sum += (p - q) * Math.log(p / q);
    observed += 1;
  }
  // If neither distribution has positive mass anywhere (shouldn't happen
  // with ε-smoothing because empty histograms collapse to a smoothed uniform),
  // fall back to 0 rather than NaN so downstream severity guards stay sane.
  if (observed === 0) return 0;
  return sum;
}

/**
 * Kullback–Leibler divergence D(actual || expected), in nats. Direction
 * is chosen so that the metric tracks "how different is the live histogram
 * from the baseline". Both arguments MUST be normalized.
 */
export function kullbackLeiblerDivergence(
  expected: Distribution,
  actual: Distribution,
): number {
  if (!expected || !actual || !expected.mass || !actual.mass) return NaN;
  const keys = alignmentKeys(expected.mass, actual.mass);
  let sum = 0;
  let observed = 0;
  for (const k of keys) {
    const q = expected.mass[k] ?? 0;
    const p = actual.mass[k] ?? 0;
    if (p <= 0 || q <= 0) continue;
    sum += p * Math.log(p / q);
    observed += 1;
  }
  if (observed === 0) return 0;
  return sum;
}

/** Per-statistic warning/critical thresholds (e.g. `{ warning: 0.1, critical: 0.2 }`). */
export interface SeverityThresholds {
  warning: number;
  critical: number;
}

/** Severity band based on the configured thresholds. */
export function severityFor(
  value: number,
  thresholds: SeverityThresholds,
): DriftSeverity {
  if (!Number.isFinite(value)) return "ok";
  if (!thresholds || typeof thresholds !== "object") return "ok";
  if (value >= thresholds.critical) return "critical";
  if (value >= thresholds.warning) return "warning";
  return "ok";
}

/** Combined severity: critical if either statistic is critical, else warning. */
export function combinedSeverity(
  psi: DriftStatisticResult,
  kl: DriftStatisticResult,
): DriftSeverity {
  if (psi.severity === "critical" || kl.severity === "critical") return "critical";
  if (psi.severity === "warning" || kl.severity === "warning") return "warning";
  return "ok";
}
