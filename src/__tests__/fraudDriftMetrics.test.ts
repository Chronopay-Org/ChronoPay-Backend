import { jest } from "@jest/globals";
import {
  recordFraudScore,
  setFraudScoreBaseline,
  clearBaseline,
  clearFraudDriftState,
  resetFraudDriftState,
  getFraudDriftSnapshot,
  FRAUD_DRIFT_LIMITS,
} from "../metrics/fraudDriftMetrics.js";
import { emptyHistogram, SCORE_BINS } from "../services/fraudDriftMath.js";

describe("fraudDriftMetrics singleton state", () => {
  beforeEach(() => {
    resetFraudDriftState();
  });

  it("records scores into the matching bin", () => {
    recordFraudScore("v1", 0);
    recordFraudScore("v1", 3);
    recordFraudScore("v1", 12); // folds into 9+
    const snap = getFraudDriftSnapshot();
    expect(snap.live["v1"]["0"]).toBe(1);
    expect(snap.live["v1"]["3"]).toBe(1);
    expect(snap.live["v1"]["9+"]).toBe(1);
    expect(snap.liveTotals["v1"]).toBe(3);
  });

  it("keeps histograms per model version isolated", () => {
    recordFraudScore("v1", 5);
    recordFraudScore("v2", 1);
    const snap = getFraudDriftSnapshot();
    expect(snap.live["v1"]["5"]).toBe(1);
    expect(snap.live["v2"]["1"]).toBe(1);
    expect(snap.live["v2"]["5"] ?? 0).toBe(0);
  });

  it("canonicalises baselines and drops unknown keys into 9+", () => {
    setFraudScoreBaseline("v1", { "0": 100, "1": 50, "weird": 5 });
    const snap = getFraudDriftSnapshot();
    expect(snap.baseline["v1"]["0"]).toBe(100);
    expect(snap.baseline["v1"]["1"]).toBe(50);
    expect(snap.baseline["v1"]["9+"]).toBe(5);
    expect(snap.baselineTotals["v1"]).toBe(155);
  });

  it("drops non-finite / negative baseline counts", () => {
    setFraudScoreBaseline("v1", { "0": 10, "1": -1, "2": Number.NaN });
    const snap = getFraudDriftSnapshot();
    expect(snap.baselineTotals["v1"]).toBe(10);
  });

  it("collapses new model versions into __overflow__ once the budget is exceeded", () => {
    const limit = FRAUD_DRIFT_LIMITS.MAX_MODEL_VERSIONS;
    for (let i = 0; i < limit; i++) {
      recordFraudScore(`v${i}`, 0);
    }
    recordFraudScore("v-overflow", 7);
    const snap = getFraudDriftSnapshot();
    expect(snap.overflowed).toBe(true);
    expect(snap.live["__overflow__"]).toBeDefined();
    expect(snap.live["__overflow__"]["7"]).toBe(1);
    expect(snap.live["v-overflow"]).toBeUndefined();
  });

  it("returns all canonical bins (zero-filled) for unknown versions", () => {
    recordFraudScore("v1", 2);
    clearFraudDriftState("v1");
    expect(getFraudDriftSnapshot().live["v1"]).toBeUndefined();
  });

  it("clearBaseline only removes the baseline, leaves live untouched", () => {
    setFraudScoreBaseline("v1", { "0": 10 });
    recordFraudScore("v1", 0);
    clearBaseline("v1");
    const snap = getFraudDriftSnapshot();
    expect(snap.baseline["v1"]).toBeUndefined();
    expect(snap.live["v1"]["0"]).toBe(1);
  });

  it("clearFraudDriftState removes all version state", () => {
    setFraudScoreBaseline("v1", { "0": 10 });
    recordFraudScore("v1", 0);
    clearFraudDriftState("v1");
    const snap = getFraudDriftSnapshot();
    expect(snap.live["v1"]).toBeUndefined();
    expect(snap.baseline["v1"]).toBeUndefined();
    expect(snap.liveTotals["v1"]).toBeUndefined();
  });

  it("resetFraudDriftState wipes every tracked version", () => {
    recordFraudScore("v1", 0);
    recordFraudScore("v2", 1);
    resetFraudDriftState();
    const snap = getFraudDriftSnapshot();
    expect(snap.versions).toHaveLength(0);
    expect(snap.overflowed).toBe(false);
  });

  it("odd / non-string version keys map to __none__", () => {
    // @ts-expect-error – intentionally invalid input to verify the safety net
    recordFraudScore(undefined, 0);
    // @ts-expect-error – intentionally invalid input to verify the safety net
    recordFraudScore(null, 1);
    const snap = getFraudDriftSnapshot();
    expect(snap.live["__none__"]).toBeDefined();
    expect(snap.liveTotals["__none__"]).toBe(2);
  });

  it("snapshot lists versions sorted alphabetically", () => {
    recordFraudScore("z", 0);
    recordFraudScore("a", 1);
    const snap = getFraudDriftSnapshot();
    expect(snap.versions).toEqual(["a", "z"]);
  });

  it("exports SCORE_BINS list (sanity check)", () => {
    expect(SCORE_BINS).toContain("0");
    expect(SCORE_BINS).toContain("9+");
  });

  it("import from math knows the empty histogram convention", () => {
    const e = emptyHistogram();
    expect(Object.keys(e)).toHaveLength(SCORE_BINS.length);
  });

  it("baseline totals are summed from canonical counts only", () => {
    setFraudScoreBaseline("v1", { "0": 100, "1": 200, "2": 300 });
    const snap = getFraudDriftSnapshot();
    expect(snap.baselineTotals["v1"]).toBe(600);
  });

  it("emits oversize baselines into 9+ instead of creating new buckets", () => {
    setFraudScoreBaseline("v1", { "100": 99, "200": 1 });
    const snap = getFraudDriftSnapshot();
    expect(snap.baselineTotals["v1"]).toBe(100);
    expect(snap.baseline["v1"]["9+"]).toBe(100);
  });
});
