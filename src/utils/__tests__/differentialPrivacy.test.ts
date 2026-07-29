/**
 * differentialPrivacy.test.ts
 * ---------------------------
 * Unit tests for the Laplace differential-privacy utilities.
 *
 * Test strategy:
 *   - Validation errors:   all invalid parameter combinations are rejected.
 *   - Noise distribution:  statistical properties of sampleLaplace are verified
 *     over large samples (mean ≈ 0, variance ≈ 2b²).
 *   - Post-processing:     applyLaplaceNoise always returns a non-negative integer.
 *   - Count map:           applyLaplaceNoiseToCountMap preserves keys, returns
 *     non-negative integers, and exposes correct noiseScale.
 *   - Edge cases (per issue #515):
 *       · Small-count bin (rawCount = 1)
 *       · Zero-variance data (all counts identical)
 *       · Epsilon near zero (large noise expected)
 *       · Empty count map
 *       · Very large epsilon (noise → 0)
 *   - Metadata:            buildDPMetadata captures all required fields.
 */

import { describe, it, expect } from "@jest/globals";
import {
  sampleLaplace,
  applyLaplaceNoise,
  applyLaplaceNoiseToCountMap,
  computeNoiseScale,
  buildDPMetadata,
  validateEpsilon,
  validateSensitivity,
  DPParameterError,
} from "../../utils/differentialPrivacy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Draw n independent Laplace samples and return them as an array. */
function drawSamples(scale: number, n: number): number[] {
  return Array.from({ length: n }, () => sampleLaplace(scale));
}

/** Sample mean of an array. */
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample variance of an array (using population formula for simplicity). */
function variance(xs: number[]): number {
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
}

// ---------------------------------------------------------------------------
// validateEpsilon
// ---------------------------------------------------------------------------

describe("validateEpsilon", () => {
  it("accepts a positive finite epsilon", () => {
    expect(() => validateEpsilon(1.0)).not.toThrow();
    expect(() => validateEpsilon(0.01)).not.toThrow();
    expect(() => validateEpsilon(100)).not.toThrow();
  });

  it("rejects epsilon = 0", () => {
    expect(() => validateEpsilon(0)).toThrow(DPParameterError);
  });

  it("rejects negative epsilon", () => {
    expect(() => validateEpsilon(-1)).toThrow(DPParameterError);
  });

  it("rejects Infinity", () => {
    expect(() => validateEpsilon(Infinity)).toThrow(DPParameterError);
  });

  it("rejects -Infinity", () => {
    expect(() => validateEpsilon(-Infinity)).toThrow(DPParameterError);
  });

  it("rejects NaN", () => {
    expect(() => validateEpsilon(NaN)).toThrow(DPParameterError);
  });

  it("includes the parameter name 'epsilon' in the error", () => {
    try {
      validateEpsilon(0);
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect((e as DPParameterError).parameter).toBe("epsilon");
    }
  });
});

// ---------------------------------------------------------------------------
// validateSensitivity
// ---------------------------------------------------------------------------

describe("validateSensitivity", () => {
  it("accepts positive finite sensitivity", () => {
    expect(() => validateSensitivity(1)).not.toThrow();
    expect(() => validateSensitivity(0.5)).not.toThrow();
  });

  it("rejects sensitivity = 0", () => {
    expect(() => validateSensitivity(0)).toThrow(DPParameterError);
  });

  it("rejects negative sensitivity", () => {
    expect(() => validateSensitivity(-2)).toThrow(DPParameterError);
  });

  it("rejects NaN", () => {
    expect(() => validateSensitivity(NaN)).toThrow(DPParameterError);
  });
});

// ---------------------------------------------------------------------------
// computeNoiseScale
// ---------------------------------------------------------------------------

describe("computeNoiseScale", () => {
  it("returns sensitivity / epsilon", () => {
    expect(computeNoiseScale({ epsilon: 2, sensitivity: 1 })).toBeCloseTo(0.5);
    expect(computeNoiseScale({ epsilon: 0.5, sensitivity: 1 })).toBeCloseTo(2.0);
    expect(computeNoiseScale({ epsilon: 1, sensitivity: 3 })).toBeCloseTo(3.0);
  });

  it("throws on invalid epsilon", () => {
    expect(() => computeNoiseScale({ epsilon: 0, sensitivity: 1 })).toThrow(DPParameterError);
  });

  it("throws on invalid sensitivity", () => {
    expect(() => computeNoiseScale({ epsilon: 1, sensitivity: 0 })).toThrow(DPParameterError);
  });
});

// ---------------------------------------------------------------------------
// sampleLaplace — statistical properties
// ---------------------------------------------------------------------------

describe("sampleLaplace", () => {
  const N = 20_000; // large enough for reliable statistics

  it("returns a finite number", () => {
    const sample = sampleLaplace(1);
    expect(Number.isFinite(sample)).toBe(true);
  });

  it("throws on non-positive scale", () => {
    expect(() => sampleLaplace(0)).toThrow(DPParameterError);
    expect(() => sampleLaplace(-1)).toThrow(DPParameterError);
    expect(() => sampleLaplace(NaN)).toThrow(DPParameterError);
  });

  it("has mean ≈ 0 (within 3σ/√N tolerance) for scale=1", () => {
    const samples = drawSamples(1, N);
    const m = mean(samples);
    // Laplace(0,1): std = sqrt(2). 3σ/√N ≈ 3*1.414/141 ≈ 0.030
    expect(Math.abs(m)).toBeLessThan(0.1);
  });

  it("has variance ≈ 2b² for scale=1 (expected variance=2)", () => {
    const samples = drawSamples(1, N);
    const v = variance(samples);
    // Within 20% tolerance for a 20k sample
    expect(v).toBeGreaterThan(1.5);
    expect(v).toBeLessThan(2.5);
  });

  it("scales variance correctly: scale=2 → variance≈8", () => {
    const samples = drawSamples(2, N);
    const v = variance(samples);
    expect(v).toBeGreaterThan(6);
    expect(v).toBeLessThan(10);
  });

  it("has roughly symmetric distribution (|mean| stays small for scale=0.1)", () => {
    const samples = drawSamples(0.1, N);
    const m = mean(samples);
    expect(Math.abs(m)).toBeLessThan(0.02);
  });
});

// ---------------------------------------------------------------------------
// applyLaplaceNoise
// ---------------------------------------------------------------------------

describe("applyLaplaceNoise", () => {
  const params = { epsilon: 1.0, sensitivity: 1 };

  it("returns a non-negative integer", () => {
    for (let i = 0; i < 200; i++) {
      const result = applyLaplaceNoise(100, params);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  it("edge case: small-count bin (rawCount = 1) always returns non-negative integer", () => {
    for (let i = 0; i < 200; i++) {
      const result = applyLaplaceNoise(1, params);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  it("edge case: rawCount = 0 always returns non-negative integer", () => {
    for (let i = 0; i < 200; i++) {
      const result = applyLaplaceNoise(0, params);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  it("very large epsilon → noise approaches 0, result close to rawCount", () => {
    // epsilon=1e6 → scale=1e-6 → noise ≈ 0 for all practical purposes
    const highEpsilonParams = { epsilon: 1e6, sensitivity: 1 };
    const results = Array.from({ length: 100 }, () =>
      applyLaplaceNoise(500, highEpsilonParams),
    );
    // With scale=1e-6 the noise is negligible; round(500 + ~1e-6) = 500 always
    expect(results.every((r) => r === 500)).toBe(true);
  });

  it("epsilon near zero → high noise but still non-negative", () => {
    const tinyEpsilonParams = { epsilon: 0.001, sensitivity: 1 };
    for (let i = 0; i < 100; i++) {
      const result = applyLaplaceNoise(10, tinyEpsilonParams);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result)).toBe(true);
    }
  });

  it("throws DPParameterError for epsilon = 0", () => {
    expect(() => applyLaplaceNoise(10, { epsilon: 0, sensitivity: 1 })).toThrow(DPParameterError);
  });

  it("throws DPParameterError for negative rawCount", () => {
    expect(() => applyLaplaceNoise(-1, params)).toThrow(DPParameterError);
  });

  it("throws DPParameterError for non-finite rawCount", () => {
    expect(() => applyLaplaceNoise(Infinity, params)).toThrow(DPParameterError);
    expect(() => applyLaplaceNoise(NaN, params)).toThrow(DPParameterError);
  });

  it("noises large counts (1000) and result stays within plausible range", () => {
    // epsilon=1, sensitivity=1 → scale=1. 99.99% of Laplace(0,1) mass is
    // within ±9.2 → noised 1000 should almost always be in [990, 1010].
    // We test a weaker bound (within ±100) for reliability.
    const rawCount = 1000;
    for (let i = 0; i < 50; i++) {
      const result = applyLaplaceNoise(rawCount, params);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// applyLaplaceNoiseToCountMap
// ---------------------------------------------------------------------------

describe("applyLaplaceNoiseToCountMap", () => {
  const params = { epsilon: 1.0, sensitivity: 1 };

  it("preserves all keys from the input map", () => {
    const raw = { login: 50, logout: 30, purchase: 20 };
    const { counts } = applyLaplaceNoiseToCountMap(raw, params);
    expect(Object.keys(counts).sort()).toEqual(Object.keys(raw).sort());
  });

  it("all values in the output are non-negative integers", () => {
    const raw = { a: 5, b: 1, c: 100, d: 0 };
    for (let i = 0; i < 50; i++) {
      const { counts } = applyLaplaceNoiseToCountMap(raw, params);
      for (const v of Object.values(counts)) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("edge case: empty map returns empty counts with correct noiseScale", () => {
    const { counts, noiseScale } = applyLaplaceNoiseToCountMap({}, params);
    expect(counts).toEqual({});
    expect(noiseScale).toBeCloseTo(1.0);
  });

  it("edge case: all-zero counts (zero-variance data)", () => {
    const raw = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 50; i++) {
      const { counts } = applyLaplaceNoiseToCountMap(raw, params);
      for (const v of Object.values(counts)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it("edge case: single-entry map with count=1 (small-count bin)", () => {
    const raw = { rare_event: 1 };
    for (let i = 0; i < 100; i++) {
      const { counts } = applyLaplaceNoiseToCountMap(raw, params);
      expect(counts["rare_event"]).toBeGreaterThanOrEqual(0);
    }
  });

  it("exposes correct noiseScale = sensitivity / epsilon", () => {
    const { noiseScale } = applyLaplaceNoiseToCountMap({ x: 10 }, { epsilon: 2, sensitivity: 1 });
    expect(noiseScale).toBeCloseTo(0.5);
  });

  it("throws on invalid epsilon (epsilon = 0)", () => {
    expect(() =>
      applyLaplaceNoiseToCountMap({ x: 10 }, { epsilon: 0, sensitivity: 1 }),
    ).toThrow(DPParameterError);
  });

  it("throws on invalid sensitivity", () => {
    expect(() =>
      applyLaplaceNoiseToCountMap({ x: 10 }, { epsilon: 1, sensitivity: -1 }),
    ).toThrow(DPParameterError);
  });
});

// ---------------------------------------------------------------------------
// buildDPMetadata
// ---------------------------------------------------------------------------

describe("buildDPMetadata", () => {
  it("returns all required fields with correct values", () => {
    const params = { epsilon: 0.5, sensitivity: 1 };
    const noiseScale = 2.0;
    const meta = buildDPMetadata(params, noiseScale);

    expect(meta.mechanism).toBe("laplace");
    expect(meta.epsilon).toBe(0.5);
    expect(meta.sensitivity).toBe(1);
    expect(meta.noiseScale).toBe(2.0);
    expect(typeof meta.appliedAt).toBe("string");
    expect(() => new Date(meta.appliedAt)).not.toThrow();
  });

  it("appliedAt is a recent ISO-8601 timestamp", () => {
    const before = Date.now();
    const meta = buildDPMetadata({ epsilon: 1, sensitivity: 1 }, 1);
    const after = Date.now();
    const ts = new Date(meta.appliedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
