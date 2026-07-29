import {
  alignmentKeys,
  canonicalizeCounts,
  combinedSeverity,
  DEFAULT_EPSILON,
  DEFAULT_THRESHOLDS,
  emptyHistogram,
  kullbackLeiblerDivergence,
  normalizeToDistribution,
  populationStabilityIndex,
  SCORE_BINS,
  scoreToBin,
  severityFor,
} from "../fraudDriftMath.js";

describe("fraudDriftMath.scoreToBin", () => {
  it("maps integer scores 0-8 to matching bins", () => {
    for (const bin of SCORE_BINS) {
      if (bin === "9+") continue;
      const n = Number(bin);
      expect(scoreToBin(n)).toBe(bin);
    }
  });

  it("clamps fractional/negative/NaN inputs to the 0 bin", () => {
    expect(scoreToBin(0.49)).toBe("0");
    expect(scoreToBin(-1)).toBe("0");
    expect(scoreToBin(Number.NaN)).toBe("0");
  });

  it("maps high scores into 9+", () => {
    expect(scoreToBin(9)).toBe("9+");
    expect(scoreToBin(42)).toBe("9+");
  });
});

describe("fraudDriftMath.emptyHistogram", () => {
  it("returns a zero-valued histogram with the canonical set of bins", () => {
    const h = emptyHistogram();
    expect(Object.keys(h).sort()).toEqual([...SCORE_BINS].sort());
    for (const v of Object.values(h)) expect(v).toBe(0);
  });
});

describe("fraudDriftMath.canonicalizeCounts", () => {
  it("drops negative / non-numeric counts", () => {
    const out = canonicalizeCounts({ "0": 10, "1": -3, "garbage": 5 });
    expect(out["0"]).toBe(10);
    expect(out["1"]).toBe(0);
    // unknown keys fold into 9+
    expect(out["9+"]).toBe(5);
  });

  it("passes known bins through unchanged", () => {
    const out = canonicalizeCounts({ "0": 1, "1": 2, "2": 3 });
    expect(out["0"]).toBe(1);
    expect(out["1"]).toBe(2);
    expect(out["2"]).toBe(3);
  });
});

describe("fraudDriftMath.alignmentKeys", () => {
  it("returns the sorted symmetric difference of bin keys", () => {
    expect(alignmentKeys({ "0": 1, "1": 2 }, { "2": 3, "3": 4 })).toEqual(["0", "1", "2", "3"]);
  });
});

describe("fraudDriftMath.normalizeToDistribution", () => {
  it("returns null for invalid inputs", () => {
    expect(normalizeToDistribution({ "0": -1 })).toBeNull();
    expect(normalizeToDistribution({ "0": Number.NaN })).toBeNull();
    expect(normalizeToDistribution({ "0": 1 }, -1 as never)).toBeNull();
    // Non-object inputs (shouldn't happen in practice but cover the type guard)

    expect(normalizeToDistribution(undefined as any)).toBeNull();

    expect(normalizeToDistribution(null as any)).toBeNull();
  });

  it("produces smoothed uniform for an empty histogram", () => {
    const d = normalizeToDistribution({});
    expect(d).not.toBeNull();
    expect(Object.values(d!.mass).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    // All bins should be approximately equal
    const values = Object.values(d!.mass);
    expect(new Set(values.map((v) => v.toFixed(6))).size).toBe(1);
  });

  it("preserves relative magnitudes when smoothing", () => {
    const d = normalizeToDistribution({ "0": 100, "1": 50 });
    expect(d!.mass["0"]).toBeGreaterThan(d!.mass["1"]);
    // Sum to 1 within numerical tolerance (9 bins carry ε-mass).
    expect(d!.mass["0"] + d!.mass["1"]).toBeCloseTo(1, 6);
  });

  it("yields mass that sums to exactly 1", () => {
    const d = normalizeToDistribution({ "0": 100, "1": 0, "2": 50, "3": 25 });
    const sum = Object.values(d!.mass).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe("fraudDriftMath.populationStabilityIndex", () => {
  function buildNormalized(counts: Record<string, number>) {
    return normalizeToDistribution(counts);
  }

  it("returns ~0 for identical distributions", () => {
    const a = buildNormalized({ "0": 100, "1": 50 });
    const b = buildNormalized({ "0": 100, "1": 50 });
    expect(populationStabilityIndex(a!, b!)).toBeCloseTo(0, 6);
  });

  it("is symmetric under swap of baseline and live", () => {
    const a = buildNormalized({ "0": 200, "1": 50 });
    const b = buildNormalized({ "0": 100, "1": 200 });
    const fwd = populationStabilityIndex(a!, b!);
    const rev = populationStabilityIndex(b!, a!);
    // PSI is symmetric by construction
    expect(fwd).toBeCloseTo(rev, 6);
  });

  it("increases monotonically as distributions diverge", () => {
    const base = buildNormalized({ "0": 500, "1": 500 })!;
    const close = buildNormalized({ "0": 480, "1": 520 })!;
    const far = buildNormalized({ "0": 100, "1": 900 })!;
    expect(populationStabilityIndex(base, close)).toBeLessThan(
      populationStabilityIndex(base, far),
    );
  });

  it("stays finite when one distribution has a zero bin (smoothing)", () => {
    const base = buildNormalized({ "0": 100, "1": 100, "2": 0 })!;
    const live = buildNormalized({ "0": 100, "1": 100 })!;
    const v = populationStabilityIndex(base, live);
    expect(Number.isFinite(v)).toBe(true);
    // The zero bin in live was lifted by ε so impact should be small but positive.
    expect(v).toBeGreaterThanOrEqual(0);
  });

  it("returns ~0 for two smoothed-empty inputs (uniform == uniform)", () => {
    const base = normalizeToDistribution({});
    const live = normalizeToDistribution({});
    // With smoothing both normalize to uniform, so the value is 0.
    expect(populationStabilityIndex(base!, live!)).toBeCloseTo(0, 6);
    expect(kullbackLeiblerDivergence(base!, live!)).toBeCloseTo(0, 6);
  });

  it("yields PSI >= DEFAULT_THRESHOLDS.psiCritical for a sharp shift", () => {
    const base = buildNormalized({ "0": 800, "1": 200 })!;
    const live = buildNormalized({ "0": 0, "1": 1000 })!;
    expect(populationStabilityIndex(base, live)).toBeGreaterThanOrEqual(
      DEFAULT_THRESHOLDS.psiCritical,
    );
  });
});

describe("fraudDriftMath.kullbackLeiblerDivergence", () => {
  function n(counts: Record<string, number>) {
    return normalizeToDistribution(counts)!;
  }

  it("returns ~0 for identical distributions", () => {
    expect(kullbackLeiblerDivergence(n({ "0": 100 }), n({ "0": 100 }))).toBeCloseTo(0, 6);
  });

  it("is asymmetric: D(p||q) != D(q||p)", () => {
    const a = n({ "0": 200, "1": 50 });
    const b = n({ "0": 100, "1": 200 });
    expect(kullbackLeiblerDivergence(a, b)).not.toBeCloseTo(
      kullbackLeiblerDivergence(b, a),
      6,
    );
  });

  it("is non-negative", () => {
    const a = n({ "0": 100, "1": 50 });
    const b = n({ "0": 50, "1": 100 });
    expect(kullbackLeiblerDivergence(a, b)).toBeGreaterThanOrEqual(0);
  });

  it("stays finite under smooth when actual has zero mass in a bin", () => {
    const base = n({ "0": 100, "1": 100, "2": 0 });
    const live = n({ "0": 100, "1": 100, "2": 100 });
    expect(Number.isFinite(kullbackLeiblerDivergence(base, live))).toBe(true);
  });
});

describe("fraudDriftMath.severityFor", () => {
  it("returns ok below warning threshold", () => {
    expect(severityFor(0.05, { warning: 0.1, critical: 0.2 })).toBe("ok");
  });
  it("returns warning between warning and critical thresholds", () => {
    expect(severityFor(0.15, { warning: 0.1, critical: 0.2 })).toBe("warning");
  });
  it("returns critical at or above critical threshold", () => {
    expect(severityFor(0.2, { warning: 0.1, critical: 0.2 })).toBe("critical");
    expect(severityFor(0.5, { warning: 0.1, critical: 0.2 })).toBe("critical");
  });
  it("returns ok for NaN / non-finite values", () => {
    expect(severityFor(Number.NaN, { warning: 0.1, critical: 0.2 })).toBe("ok");
  });
});

describe("fraudDriftMath.combinedSeverity", () => {
  it("returns critical when either statistic is critical", () => {
    expect(
      combinedSeverity(
        { value: 0, severity: "ok" },
        { value: 0.5, severity: "critical" },
      ),
    ).toBe("critical");
  });
  it("returns warning when either is warning and none is critical", () => {
    expect(
      combinedSeverity(
        { value: 0.15, severity: "warning" },
        { value: 0, severity: "ok" },
      ),
    ).toBe("warning");
  });
  it("returns ok when both are ok", () => {
    expect(
      combinedSeverity(
        { value: 0, severity: "ok" },
        { value: 0, severity: "ok" },
      ),
    ).toBe("ok");
  });
});

describe("fraudDriftMath.constants", () => {
  it("exposes 10 canonical bins (0-8 + 9+)", () => {
    expect(SCORE_BINS).toHaveLength(10);
    expect(SCORE_BINS[SCORE_BINS.length - 1]).toBe("9+");
  });
  it("ships sane default thresholds", () => {
    expect(DEFAULT_EPSILON).toBeGreaterThan(0);
    expect(DEFAULT_THRESHOLDS.psiWarning).toBeLessThan(DEFAULT_THRESHOLDS.psiCritical);
    expect(DEFAULT_THRESHOLDS.klWarning).toBeLessThan(DEFAULT_THRESHOLDS.klCritical);
  });
});
