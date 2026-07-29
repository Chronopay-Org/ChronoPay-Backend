import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  calculatePayoutBackoffDelay,
  validateProviderRetryConfig,
  getProviderRetryConfig,
  isRetryable,
  providerRetryRegistry,
  DEFAULT_PROVIDER_RETRY_CONFIG,
  type ProviderRetryConfig,
} from "../payoutRetryPolicy.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid config for a given provider id. */
function cfg(overrides: Partial<ProviderRetryConfig> = {}): ProviderRetryConfig {
  return {
    providerId: "test-provider",
    baseDelayMs: 1_000,
    multiplier: 2,
    maxDelayCeilingMs: 30_000,
    maxRetries: 5,
    ...overrides,
  };
}

/**
 * Deterministic random that always returns the fixed fraction `f`.
 * With f=0 → delayMs = 0; f=1 → delayMs = capMs (via floor rounding).
 */
const alwaysZero = () => 0;
const alwaysOne = () => 0.9999999; // stays below 1 per spec

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("calculatePayoutBackoffDelay", () => {
  describe("full-jitter algorithm", () => {
    it("returns delayMs=0 when random()=0", () => {
      const result = calculatePayoutBackoffDelay(0, cfg(), alwaysZero);
      expect(result.delayMs).toBe(0);
    });

    it("returns delayMs close to capMs when random() approaches 1", () => {
      const result = calculatePayoutBackoffDelay(0, cfg({ baseDelayMs: 1_000 }), alwaysOne);
      // floor(0.9999999 * 1001) = 1000
      expect(result.delayMs).toBe(1_000);
    });

    it("delayMs is always in [0, capMs] for 1000 random samples", () => {
      const config = cfg({ baseDelayMs: 500, multiplier: 2, maxDelayCeilingMs: 8_000 });
      for (let attempt = 0; attempt < 5; attempt++) {
        for (let i = 0; i < 200; i++) {
          const { delayMs, capMs } = calculatePayoutBackoffDelay(attempt, config);
          expect(delayMs).toBeGreaterThanOrEqual(0);
          expect(delayMs).toBeLessThanOrEqual(capMs);
        }
      }
    });

    it("delayMs is an integer (compatible with setTimeout granularity)", () => {
      const config = cfg();
      for (let attempt = 0; attempt < 8; attempt++) {
        const { delayMs } = calculatePayoutBackoffDelay(attempt, config);
        expect(Number.isInteger(delayMs)).toBe(true);
      }
    });

    it("uses the injected random function, not Math.random", () => {
      const calls: number[] = [];
      const spy = () => {
        const v = 0.5;
        calls.push(v);
        return v;
      };
      calculatePayoutBackoffDelay(1, cfg(), spy);
      expect(calls).toHaveLength(1);
    });
  });

  describe("exponential cap growth", () => {
    it("cap doubles each attempt with multiplier=2", () => {
      const config = cfg({ baseDelayMs: 1_000, multiplier: 2, maxDelayCeilingMs: 999_999 });
      const caps = [0, 1, 2, 3].map(
        (attempt) => calculatePayoutBackoffDelay(attempt, config, alwaysZero).capMs,
      );
      expect(caps).toEqual([1_000, 2_000, 4_000, 8_000]);
    });

    it("cap triples each attempt with multiplier=3", () => {
      const config = cfg({ baseDelayMs: 100, multiplier: 3, maxDelayCeilingMs: 999_999 });
      const caps = [0, 1, 2].map(
        (attempt) => calculatePayoutBackoffDelay(attempt, config, alwaysZero).capMs,
      );
      expect(caps).toEqual([100, 300, 900]);
    });

    it("returns attempt and providerId on the result object", () => {
      const result = calculatePayoutBackoffDelay(3, cfg({ providerId: "ach" }), alwaysZero);
      expect(result.attempt).toBe(3);
      expect(result.providerId).toBe("ach");
    });
  });

  describe("per-provider ceiling enforcement", () => {
    it("caps at maxDelayCeilingMs when exponential would exceed it", () => {
      // attempt=10: 1000 * 2^10 = 1_024_000 >> ceiling of 5_000
      const result = calculatePayoutBackoffDelay(10, cfg({ maxDelayCeilingMs: 5_000 }), alwaysZero);
      expect(result.capMs).toBe(5_000);
    });

    it("ceiling < base: cap is the ceiling from attempt 0", () => {
      // ceiling=500 < base=1000 → cap must be 500 even on attempt 0
      const result = calculatePayoutBackoffDelay(0, cfg({ baseDelayMs: 1_000, maxDelayCeilingMs: 500 }), alwaysZero);
      expect(result.capMs).toBe(500);
      expect(result.delayMs).toBe(0); // alwaysZero random
    });

    it("ceiling=1 enforces near-zero delay on all attempts", () => {
      const config = cfg({ maxDelayCeilingMs: 1, baseDelayMs: 1_000 });
      for (let attempt = 0; attempt < 10; attempt++) {
        const { capMs, delayMs } = calculatePayoutBackoffDelay(attempt, config);
        expect(capMs).toBe(1);
        expect(delayMs).toBeGreaterThanOrEqual(0);
        expect(delayMs).toBeLessThanOrEqual(1);
      }
    });

    it("ceiling is honoured at very high attempt counts (no overflow)", () => {
      const config = cfg({ baseDelayMs: 1_000, multiplier: 2, maxDelayCeilingMs: 10_000 });
      // attempt=100 would produce 1000 * 2^100 ≈ 1.27e33 without ceiling
      const result = calculatePayoutBackoffDelay(100, config, alwaysZero);
      expect(result.capMs).toBe(10_000);
      expect(result.delayMs).toBe(0);
    });

    it("ceiling equals base: cap is always the base regardless of attempt", () => {
      const config = cfg({ baseDelayMs: 2_000, multiplier: 2, maxDelayCeilingMs: 2_000 });
      for (let attempt = 0; attempt < 6; attempt++) {
        const { capMs } = calculatePayoutBackoffDelay(attempt, config, alwaysZero);
        expect(capMs).toBe(2_000);
      }
    });
  });

  describe("thundering-herd prevention (jitter spread)", () => {
    it("produces diverse delays across 100 concurrent retriers", () => {
      const config = cfg({ baseDelayMs: 1_000, maxDelayCeilingMs: 10_000 });
      const delays = Array.from({ length: 100 }, () =>
        calculatePayoutBackoffDelay(2, config).delayMs,
      );
      const uniqueDelays = new Set(delays);
      // With real Math.random over [0, 4000], collision probability is negligible.
      // We expect at least 50 distinct values across 100 samples.
      expect(uniqueDelays.size).toBeGreaterThan(50);
    });

    it("mean delay is roughly half the cap (full-jitter expectation)", () => {
      const config = cfg({ baseDelayMs: 1_000, multiplier: 2, maxDelayCeilingMs: 999_999 });
      // attempt=3 → cap = 8000ms; E[delay] ≈ 4000ms
      const samples = Array.from({ length: 2_000 }, () =>
        calculatePayoutBackoffDelay(3, config).delayMs,
      );
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      // Allow ±20% tolerance around 4000ms
      expect(mean).toBeGreaterThan(3_200);
      expect(mean).toBeLessThan(4_800);
    });
  });

  describe("clock-skew / time invariance", () => {
    it("produces the same cap regardless of wall-clock time", () => {
      // calculatePayoutBackoffDelay is a pure function — it has no dependency
      // on Date.now() — so results must be identical across two calls separated
      // by any real elapsed time.
      const config = cfg({ baseDelayMs: 500, multiplier: 3, maxDelayCeilingMs: 20_000 });
      const r1 = calculatePayoutBackoffDelay(2, config, alwaysZero);
      const r2 = calculatePayoutBackoffDelay(2, config, alwaysZero);
      expect(r1.capMs).toBe(r2.capMs);
      expect(r1.delayMs).toBe(r2.delayMs);
    });
  });

  describe("input validation", () => {
    it("throws on negative attempt", () => {
      expect(() => calculatePayoutBackoffDelay(-1, cfg())).toThrow(/attempt must be a non-negative integer/);
    });

    it("throws on fractional attempt", () => {
      expect(() => calculatePayoutBackoffDelay(1.5, cfg())).toThrow(/attempt must be a non-negative integer/);
    });

    it("throws when baseDelayMs is zero", () => {
      expect(() => calculatePayoutBackoffDelay(0, cfg({ baseDelayMs: 0 }))).toThrow(/baseDelayMs must be a positive integer/);
    });

    it("throws when baseDelayMs is negative", () => {
      expect(() => calculatePayoutBackoffDelay(0, cfg({ baseDelayMs: -100 }))).toThrow(/baseDelayMs must be a positive integer/);
    });

    it("throws when maxDelayCeilingMs is zero", () => {
      expect(() => calculatePayoutBackoffDelay(0, cfg({ maxDelayCeilingMs: 0 }))).toThrow(/maxDelayCeilingMs must be a positive integer/);
    });

    it("throws when multiplier is less than 1", () => {
      expect(() => calculatePayoutBackoffDelay(0, cfg({ multiplier: 0.5 }))).toThrow(/multiplier must be >= 1/);
    });

    it("throws when providerId is empty", () => {
      expect(() => calculatePayoutBackoffDelay(0, cfg({ providerId: "" }))).toThrow(/providerId must be a non-empty string/);
    });

    it("throws when maxRetries is negative", () => {
      expect(() => calculatePayoutBackoffDelay(0, cfg({ maxRetries: -1 }))).toThrow(/maxRetries must be a non-negative integer/);
    });

    it("allows attempt=0 with maxRetries=0 (single-shot, no retry)", () => {
      expect(() => calculatePayoutBackoffDelay(0, cfg({ maxRetries: 0 }))).not.toThrow();
    });

    it("allows multiplier=1 (no growth — constant base delay)", () => {
      const config = cfg({ multiplier: 1, baseDelayMs: 500, maxDelayCeilingMs: 500 });
      const caps = [0, 1, 2, 3].map(
        (a) => calculatePayoutBackoffDelay(a, config, alwaysZero).capMs,
      );
      // multiplier=1 → base * 1^n = base for all n
      expect(caps).toEqual([500, 500, 500, 500]);
    });
  });
});

// ─── validateProviderRetryConfig ─────────────────────────────────────────────

describe("validateProviderRetryConfig", () => {
  it("passes for a fully valid config", () => {
    expect(() => validateProviderRetryConfig(cfg())).not.toThrow();
  });

  it("throws for fractional maxDelayCeilingMs", () => {
    expect(() => validateProviderRetryConfig(cfg({ maxDelayCeilingMs: 1000.5 }))).toThrow();
  });

  it("throws for fractional maxRetries", () => {
    expect(() => validateProviderRetryConfig(cfg({ maxRetries: 2.5 }))).toThrow();
  });
});

// ─── providerRetryRegistry / getProviderRetryConfig ──────────────────────────

describe("providerRetryRegistry", () => {
  beforeEach(() => {
    providerRetryRegistry.clear();
  });

  it("returns DEFAULT_PROVIDER_RETRY_CONFIG merged with providerId when no entry is registered", () => {
    const result = getProviderRetryConfig("unknown-provider");
    expect(result).toEqual({ providerId: "unknown-provider", ...DEFAULT_PROVIDER_RETRY_CONFIG });
  });

  it("returns the registered config when an entry exists", () => {
    const custom: ProviderRetryConfig = {
      providerId: "sepa",
      baseDelayMs: 2_000,
      multiplier: 3,
      maxDelayCeilingMs: 60_000,
      maxRetries: 8,
    };
    providerRetryRegistry.set("sepa", custom);
    expect(getProviderRetryConfig("sepa")).toEqual(custom);
  });

  it("does not bleed between providers", () => {
    providerRetryRegistry.set("ach", cfg({ providerId: "ach", maxDelayCeilingMs: 10_000 }));
    providerRetryRegistry.set("crypto", cfg({ providerId: "crypto", maxDelayCeilingMs: 5_000 }));

    expect(getProviderRetryConfig("ach").maxDelayCeilingMs).toBe(10_000);
    expect(getProviderRetryConfig("crypto").maxDelayCeilingMs).toBe(5_000);
  });

  it("ceiling is always honoured after registry lookup", () => {
    providerRetryRegistry.set("wire", cfg({ providerId: "wire", baseDelayMs: 1_000, maxDelayCeilingMs: 3_000 }));
    const wireCfg = getProviderRetryConfig("wire");
    // Attempt 10 → exponential cap >> ceiling
    const result = calculatePayoutBackoffDelay(10, wireCfg, alwaysZero);
    expect(result.capMs).toBe(3_000);
  });
});

// ─── isRetryable ─────────────────────────────────────────────────────────────

describe("isRetryable", () => {
  it("returns true when attempt < maxRetries", () => {
    expect(isRetryable(0, cfg({ maxRetries: 5 }))).toBe(true);
    expect(isRetryable(4, cfg({ maxRetries: 5 }))).toBe(true);
  });

  it("returns false when attempt === maxRetries", () => {
    expect(isRetryable(5, cfg({ maxRetries: 5 }))).toBe(false);
  });

  it("returns false when attempt > maxRetries", () => {
    expect(isRetryable(6, cfg({ maxRetries: 5 }))).toBe(false);
  });

  it("returns false immediately when maxRetries=0", () => {
    expect(isRetryable(0, cfg({ maxRetries: 0 }))).toBe(false);
  });
});
