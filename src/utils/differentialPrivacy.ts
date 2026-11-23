/**
 * differentialPrivacy.ts
 * ----------------------
 * Pure implementation of the Laplace mechanism for differential privacy.
 *
 * The Laplace mechanism adds calibrated random noise to numeric query results
 * so that the presence or absence of any single individual cannot be inferred
 * from the published aggregate. For a query with L1-sensitivity Δf and privacy
 * budget ε, noise is drawn from Lap(Δf / ε).
 *
 * Security properties:
 *   - Noise is drawn via the inverse-CDF method using crypto.getRandomValues so
 *     the PRNG is cryptographically secure (CSPRNG).
 *   - Epsilon must be strictly positive; zero or negative values are rejected to
 *     prevent infinite noise or silent identity release.
 *   - Sensitivity must be strictly positive; non-positive values indicate a
 *     degenerate query with no privacy guarantee.
 *   - Noised counts are clamped to [0, +∞) before rounding because negative
 *     counts are semantically invalid.  Post-processing (clamping, rounding)
 *     does not degrade the ε guarantee — it is a post-processing step on an
 *     already DP output.
 *
 * References:
 *   - Dwork & Roth, "The Algorithmic Foundations of Differential Privacy", 2014
 *   - Mironov, "On Significance of the Least Significant Bits for DP", CCS 2012
 *     (discusses floating-point DP; our counts-only use-case avoids those issues
 *      because we clamp+round to integers before publishing)
 *
 * No I/O. No module-level mutable state. Fully unit-testable in isolation.
 */

import { webcrypto } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Validated parameters for a single Laplace noise application. */
export interface LaplaceParams {
  /** Privacy budget allocated to this query (must be > 0). */
  epsilon: number;
  /**
   * L1-sensitivity of the query: the maximum change in the query's output
   * when one individual's record is added or removed from the dataset.
   * For simple COUNT queries sensitivity = 1.
   */
  sensitivity: number;
}

/** Result of applying Laplace noise to a map of named counts. */
export interface NoisedCountMap {
  /** Noised, clamped, and rounded counts keyed by their original label. */
  counts: Record<string, number>;
  /**
   * Scale of the Laplace distribution used: b = sensitivity / epsilon.
   * Exposed so downstream callers can record the noise scale in metadata.
   */
  noiseScale: number;
}

/** Metadata appended to an analytics export describing the DP parameters used. */
export interface DifferentialPrivacyMetadata {
  mechanism: "laplace";
  epsilon: number;
  sensitivity: number;
  noiseScale: number;
  /** ISO-8601 timestamp of when the noise was applied. */
  appliedAt: string;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Validate epsilon: must be a finite positive number.
 * Throws {@link DPParameterError} on invalid input.
 */
export function validateEpsilon(epsilon: number): void {
  if (!Number.isFinite(epsilon) || epsilon <= 0) {
    throw new DPParameterError(
      `epsilon must be a finite positive number, got: ${epsilon}`,
      "epsilon",
      epsilon,
    );
  }
}

/**
 * Validate sensitivity: must be a finite positive number.
 * Throws {@link DPParameterError} on invalid input.
 */
export function validateSensitivity(sensitivity: number): void {
  if (!Number.isFinite(sensitivity) || sensitivity <= 0) {
    throw new DPParameterError(
      `sensitivity must be a finite positive number, got: ${sensitivity}`,
      "sensitivity",
      sensitivity,
    );
  }
}

/** Validates both epsilon and sensitivity together. */
export function validateLaplaceParams(params: LaplaceParams): void {
  validateEpsilon(params.epsilon);
  validateSensitivity(params.sensitivity);
}

// ---------------------------------------------------------------------------
// Core CSPRNG Laplace sampler
// ---------------------------------------------------------------------------

/**
 * Draw a single sample from Lap(0, scale) using the inverse-CDF method with
 * a cryptographically secure uniform random source.
 *
 *   U ~ Uniform(0, 1) \ {0.5}  (we reject exactly 0.5 to avoid log(0))
 *   X = -scale * sign(U - 0.5) * ln(1 - 2|U - 0.5|)
 *
 * The rejection of U=0.5 (probability 2^-53 for a 64-bit float) keeps the
 * log argument strictly positive and avoids -Infinity.
 *
 * Using webcrypto.getRandomValues for the underlying random bytes ensures
 * we do not depend on Math.random() which is not cryptographically secure.
 *
 * @param scale - The scale parameter b > 0 of the Laplace distribution.
 */
export function sampleLaplace(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new DPParameterError(
      `Laplace scale must be a finite positive number, got: ${scale}`,
      "scale",
      scale,
    );
  }

  // Rejection loop: in practice we almost never iterate more than once.
  for (;;) {
    // Generate a 64-bit float in [0, 1) via 53 random bits (standard technique).
    const buf = new Uint32Array(2);
    webcrypto.getRandomValues(buf);
    // Use the top 26 bits of buf[0] and all 27 bits of buf[1] for 53 bits total.
    const hi = buf[0] >>> 6; // 26 bits
    const lo = buf[1] >>> 5; // 27 bits
    const u = (hi * (2 ** 27) + lo) / 2 ** 53; // in [0, 1)

    // Avoid the degenerate case where u = 0.5 exactly (log argument = 0).
    if (u === 0.5) continue;

    const sign = u < 0.5 ? -1 : 1;
    const noise = -scale * sign * Math.log(1 - 2 * Math.abs(u - 0.5));

    if (Number.isFinite(noise)) return noise;
    // Theoretically unreachable given the u === 0.5 guard, but be defensive.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the Laplace noise scale for given epsilon and sensitivity.
 *
 *   b = sensitivity / epsilon
 */
export function computeNoiseScale(params: LaplaceParams): number {
  validateLaplaceParams(params);
  return params.sensitivity / params.epsilon;
}

/**
 * Apply Laplace noise to a single raw count.
 *
 * The noised value is clamped to [0, +∞) and rounded to the nearest integer.
 * Clamping is a valid post-processing step that does not consume additional
 * epsilon budget.
 *
 * @param rawCount - The true aggregate count. Must be a finite non-negative integer.
 * @param params   - Validated epsilon and sensitivity values.
 * @returns Noised, clamped, rounded non-negative integer.
 */
export function applyLaplaceNoise(rawCount: number, params: LaplaceParams): number {
  validateLaplaceParams(params);

  if (!Number.isFinite(rawCount) || rawCount < 0) {
    throw new DPParameterError(
      `rawCount must be a finite non-negative number, got: ${rawCount}`,
      "rawCount",
      rawCount,
    );
  }

  const scale = computeNoiseScale(params);
  const noise = sampleLaplace(scale);
  const noised = rawCount + noise;

  // Clamp to [0, +∞) — negative counts are semantically invalid.
  const clamped = Math.max(0, noised);

  // Round to nearest integer — counts are discrete.
  return Math.round(clamped);
}

/**
 * Apply Laplace noise to every value in a named count map.
 *
 * Each entry is treated as an independent query sharing the same epsilon and
 * sensitivity. The caller is responsible for epsilon budget accounting across
 * calls (see {@link EpsilonBudgetTracker}).
 *
 * @param rawCounts - A record mapping arbitrary string labels to raw counts.
 * @param params    - DP parameters (epsilon, sensitivity).
 * @returns {@link NoisedCountMap} with per-label noised counts and the scale used.
 */
export function applyLaplaceNoiseToCountMap(
  rawCounts: Record<string, number>,
  params: LaplaceParams,
): NoisedCountMap {
  validateLaplaceParams(params);

  const scale = computeNoiseScale(params);
  const counts: Record<string, number> = {};

  for (const [label, rawCount] of Object.entries(rawCounts)) {
    counts[label] = applyLaplaceNoise(rawCount, params);
  }

  return { counts, noiseScale: scale };
}

/**
 * Build the {@link DifferentialPrivacyMetadata} record that gets embedded in
 * every analytics export to document the privacy parameters used.
 */
export function buildDPMetadata(
  params: LaplaceParams,
  noiseScale: number,
): DifferentialPrivacyMetadata {
  return {
    mechanism: "laplace",
    epsilon: params.epsilon,
    sensitivity: params.sensitivity,
    noiseScale,
    appliedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class DPParameterError extends Error {
  constructor(
    message: string,
    public readonly parameter: string,
    public readonly value: unknown,
  ) {
    super(message);
    this.name = "DPParameterError";
  }
}
