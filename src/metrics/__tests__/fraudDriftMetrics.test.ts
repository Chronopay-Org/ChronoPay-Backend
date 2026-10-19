import {
  recordFraudScore,
  setFraudScoreBaseline,
  clearBaseline,
  clearFraudDriftState,
  getFraudDriftSnapshot,
  resetFraudDriftState,
  FRAUD_DRIFT_LIMITS,
  type FraudDriftSnapshot,
} from "../fraudDriftMetrics.js";
import { SCORE_BINS, type HistogramCounts, type ScoreBin } from "../../services/fraudDriftMath.js";

describe("src/metrics/fraudDriftMetrics", () => {
  beforeEach(() => {
    resetFraudDriftState();
  });

  // =========================================================================
  // 1. Initial State & Clean Reset
  // =========================================================================
  describe("initial state and resetFraudDriftState", () => {
    it("returns an empty snapshot on initial state", () => {
      const snap: FraudDriftSnapshot = getFraudDriftSnapshot();
      expect(snap.versions).toEqual([]);
      expect(snap.live).toEqual({});
      expect(snap.baseline).toEqual({});
      expect(snap.liveTotals).toEqual({});
      expect(snap.baselineTotals).toEqual({});
      expect(snap.overflowed).toBe(false);
    });

    it("resets all live, baseline, totals, and overflow state on resetFraudDriftState", () => {
      recordFraudScore("model-v1", 4);
      setFraudScoreBaseline("model-v1", { "4": 100 });
      expect(getFraudDriftSnapshot().versions).toContain("model-v1");

      resetFraudDriftState();

      const snap = getFraudDriftSnapshot();
      expect(snap.versions).toEqual([]);
      expect(snap.live).toEqual({});
      expect(snap.baseline).toEqual({});
      expect(snap.liveTotals).toEqual({});
      expect(snap.baselineTotals).toEqual({});
      expect(snap.overflowed).toBe(false);
    });
  });

  // =========================================================================
  // 2. recordFraudScore: Valid Inputs, Binning & Live Counts
  // =========================================================================
  describe("recordFraudScore - success paths and score binning", () => {
    it("initializes all canonical bins to zero when a version is first recorded", () => {
      recordFraudScore("v1", 0);
      const snap = getFraudDriftSnapshot();
      expect(snap.live["v1"]).toBeDefined();

      for (const bin of SCORE_BINS) {
        if (bin === "0") {
          expect(snap.live["v1"][bin]).toBe(1);
        } else {
          expect(snap.live["v1"][bin]).toBe(0);
        }
      }
    });

    it("records integer boundary scores (0 through 8) into exact matching bins", () => {
      for (let score = 0; score <= 8; score++) {
        recordFraudScore("v1", score);
      }
      const snap = getFraudDriftSnapshot();
      for (let score = 0; score <= 8; score++) {
        expect(snap.live["v1"][String(score) as ScoreBin]).toBe(1);
      }
      expect(snap.live["v1"]["9+"]).toBe(0);
      expect(snap.liveTotals["v1"]).toBe(9);
    });

    it("floors floating point scores into appropriate bins", () => {
      recordFraudScore("v1", 0.1);
      recordFraudScore("v1", 0.99);
      recordFraudScore("v1", 3.4);
      recordFraudScore("v1", 8.99);

      const snap = getFraudDriftSnapshot();
      expect(snap.live["v1"]["0"]).toBe(2);
      expect(snap.live["v1"]["3"]).toBe(1);
      expect(snap.live["v1"]["8"]).toBe(1);
      expect(snap.liveTotals["v1"]).toBe(4);
    });

    it("folds scores >= 9 into the 9+ overflow bin", () => {
      recordFraudScore("v1", 9);
      recordFraudScore("v1", 9.5);
      recordFraudScore("v1", 10);
      recordFraudScore("v1", 100);

      const snap = getFraudDriftSnapshot();
      expect(snap.live["v1"]["9+"]).toBe(4);
      expect(snap.liveTotals["v1"]).toBe(4);
    });

    it("accumulates multiple observations across multiple calls", () => {
      recordFraudScore("v1", 2);
      recordFraudScore("v1", 2);
      recordFraudScore("v1", 2);
      recordFraudScore("v1", 5);

      const snap = getFraudDriftSnapshot();
      expect(snap.live["v1"]["2"]).toBe(3);
      expect(snap.live["v1"]["5"]).toBe(1);
      expect(snap.liveTotals["v1"]).toBe(4);
    });

    it("keeps live score histograms isolated across different model versions", () => {
      recordFraudScore("alpha", 1);
      recordFraudScore("beta", 8);

      const snap = getFraudDriftSnapshot();
      expect(snap.live["alpha"]["1"]).toBe(1);
      expect(snap.live["alpha"]["8"]).toBe(0);
      expect(snap.live["beta"]["1"]).toBe(0);
      expect(snap.live["beta"]["8"]).toBe(1);
      expect(snap.liveTotals["alpha"]).toBe(1);
      expect(snap.liveTotals["beta"]).toBe(1);
    });
  });

  // =========================================================================
  // 3. recordFraudScore: Representative Invalid Inputs & Boundaries
  // =========================================================================
  describe("recordFraudScore - invalid and boundary inputs", () => {
    it("clamps negative scores to bin 0", () => {
      recordFraudScore("v1", -1);
      recordFraudScore("v1", -0.0001);
      recordFraudScore("v1", -999);

      const snap = getFraudDriftSnapshot();
      expect(snap.live["v1"]["0"]).toBe(3);
      expect(snap.liveTotals["v1"]).toBe(3);
    });

    it("clamps non-finite scores (NaN, Infinity, -Infinity) to bin 0", () => {
      recordFraudScore("v1", Number.NaN);
      recordFraudScore("v1", Number.POSITIVE_INFINITY);
      recordFraudScore("v1", Number.NEGATIVE_INFINITY);

      const snap = getFraudDriftSnapshot();
      expect(snap.live["v1"]["0"]).toBe(3);
      expect(snap.liveTotals["v1"]).toBe(3);
    });

    it("maps empty or non-string modelVersion values to sentinel __none__", () => {
      recordFraudScore("", 1);
      // @ts-expect-error test non-string runtime boundary
      recordFraudScore(null, 2);
      // @ts-expect-error test non-string runtime boundary
      recordFraudScore(undefined, 3);
      // @ts-expect-error test non-string runtime boundary
      recordFraudScore(12345, 4);
      // @ts-expect-error test non-string runtime boundary
      recordFraudScore(false, 5);
      // @ts-expect-error test non-string runtime boundary
      recordFraudScore({ version: "v1" }, 6);

      const snap = getFraudDriftSnapshot();
      expect(snap.versions).toEqual(["__none__"]);
      expect(snap.live["__none__"]).toBeDefined();
      expect(snap.live["__none__"]["1"]).toBe(1);
      expect(snap.live["__none__"]["2"]).toBe(1);
      expect(snap.live["__none__"]["3"]).toBe(1);
      expect(snap.live["__none__"]["4"]).toBe(1);
      expect(snap.live["__none__"]["5"]).toBe(1);
      expect(snap.live["__none__"]["6"]).toBe(1);
      expect(snap.liveTotals["__none__"]).toBe(6);
    });
  });

  // =========================================================================
  // 4. setFraudScoreBaseline: Canonicalization & Baseline Totals
  // =========================================================================
  describe("setFraudScoreBaseline - success paths and canonicalization", () => {
    it("sets baseline histogram with canonical bins and computes baselineTotals", () => {
      const inputBaseline: HistogramCounts = {
        "0": 100,
        "1": 200,
        "5": 50,
        "9+": 10,
      };
      setFraudScoreBaseline("v1", inputBaseline);

      const snap = getFraudDriftSnapshot();
      expect(snap.baseline["v1"]).toBeDefined();
      expect(snap.baseline["v1"]["0"]).toBe(100);
      expect(snap.baseline["v1"]["1"]).toBe(200);
      expect(snap.baseline["v1"]["5"]).toBe(50);
      expect(snap.baseline["v1"]["9+"]).toBe(10);
      // All other canonical bins should be present and 0
      expect(snap.baseline["v1"]["2"]).toBe(0);
      expect(snap.baselineTotals["v1"]).toBe(360);
    });

    it("replaces existing baseline when setFraudScoreBaseline is called again", () => {
      setFraudScoreBaseline("v1", { "0": 100 });
      expect(getFraudDriftSnapshot().baselineTotals["v1"]).toBe(100);

      setFraudScoreBaseline("v1", { "0": 20, "1": 30 });
      const snap = getFraudDriftSnapshot();
      expect(snap.baseline["v1"]["0"]).toBe(20);
      expect(snap.baseline["v1"]["1"]).toBe(30);
      expect(snap.baselineTotals["v1"]).toBe(50);
    });

    it("keeps baseline histograms isolated across versions", () => {
      setFraudScoreBaseline("v1", { "0": 100 });
      setFraudScoreBaseline("v2", { "1": 200 });

      const snap = getFraudDriftSnapshot();
      expect(snap.baseline["v1"]["0"]).toBe(100);
      expect(snap.baseline["v1"]["1"]).toBe(0);
      expect(snap.baseline["v2"]["0"]).toBe(0);
      expect(snap.baseline["v2"]["1"]).toBe(200);
      expect(snap.baselineTotals["v1"]).toBe(100);
      expect(snap.baselineTotals["v2"]).toBe(200);
    });
  });

  // =========================================================================
  // 5. setFraudScoreBaseline: Representative Invalid Inputs
  // =========================================================================
  describe("setFraudScoreBaseline - invalid inputs and edge cases", () => {
    it("folds non-canonical or out-of-range keys into 9+ bin", () => {
      setFraudScoreBaseline("v1", {
        "0": 50,
        "10": 15,
        "99": 5,
        unknown_bin: 20,
      });

      const snap = getFraudDriftSnapshot();
      expect(snap.baseline["v1"]["0"]).toBe(50);
      // 15 + 5 + 20 folded into "9+"
      expect(snap.baseline["v1"]["9+"]).toBe(40);
      expect(snap.baselineTotals["v1"]).toBe(90);
    });

    it("drops non-positive counts (negative and zero)", () => {
      setFraudScoreBaseline("v1", {
        "0": 10,
        "1": 0,
        "2": -15,
        "3": -0.001,
      });

      const snap = getFraudDriftSnapshot();
      expect(snap.baseline["v1"]["0"]).toBe(10);
      expect(snap.baseline["v1"]["1"]).toBe(0);
      expect(snap.baseline["v1"]["2"]).toBe(0);
      expect(snap.baseline["v1"]["3"]).toBe(0);
      expect(snap.baselineTotals["v1"]).toBe(10);
    });

    it("drops non-finite counts (NaN, Infinity, -Infinity)", () => {
      setFraudScoreBaseline("v1", {
        "0": 25,
        "1": Number.NaN,
        "2": Number.POSITIVE_INFINITY,
        "3": Number.NEGATIVE_INFINITY,
      });

      const snap = getFraudDriftSnapshot();
      expect(snap.baseline["v1"]["0"]).toBe(25);
      expect(snap.baseline["v1"]["1"]).toBe(0);
      expect(snap.baseline["v1"]["2"]).toBe(0);
      expect(snap.baseline["v1"]["3"]).toBe(0);
      expect(snap.baselineTotals["v1"]).toBe(25);
    });

    it("handles an empty histogram by setting all bins and totals to 0", () => {
      setFraudScoreBaseline("v1", {});

      const snap = getFraudDriftSnapshot();
      for (const bin of SCORE_BINS) {
        expect(snap.baseline["v1"][bin]).toBe(0);
      }
      expect(snap.baselineTotals["v1"]).toBe(0);
    });

    it("maps invalid modelVersion in setFraudScoreBaseline to __none__", () => {
      // @ts-expect-error test non-string runtime boundary
      setFraudScoreBaseline(null, { "0": 42 });
      // @ts-expect-error test non-string runtime boundary
      setFraudScoreBaseline(undefined, { "1": 18 });
      setFraudScoreBaseline("", { "2": 10 });

      const snap = getFraudDriftSnapshot();
      expect(snap.versions).toEqual(["__none__"]);
      // The last call overwrites __none__ baseline
      expect(snap.baseline["__none__"]["2"]).toBe(10);
      expect(snap.baselineTotals["__none__"]).toBe(10);
    });
  });

  // =========================================================================
  // 6. Cardinality Bounding & Overflow Behavior
  // =========================================================================
  describe("cardinality bounding and overflow behavior", () => {
    it("tracks up to MAX_MODEL_VERSIONS (8) distinct versions without overflow", () => {
      const max = FRAUD_DRIFT_LIMITS.MAX_MODEL_VERSIONS;
      for (let i = 0; i < max; i++) {
        recordFraudScore(`v${i}`, i);
      }

      const snap = getFraudDriftSnapshot();
      expect(snap.versions).toHaveLength(max);
      expect(snap.overflowed).toBe(false);
      expect(snap.live[FRAUD_DRIFT_LIMITS.OVERFLOW_VERSION_KEY]).toBeUndefined();
    });

    it("routes 9th distinct version and beyond into __overflow__ key and marks overflowed=true", () => {
      const max = FRAUD_DRIFT_LIMITS.MAX_MODEL_VERSIONS;
      for (let i = 0; i < max; i++) {
        recordFraudScore(`model-${i}`, 0);
      }

      expect(getFraudDriftSnapshot().overflowed).toBe(false);

      // 9th distinct version
      recordFraudScore("overflow-model-a", 3);
      let snap = getFraudDriftSnapshot();
      expect(snap.overflowed).toBe(true);
      expect(snap.live["overflow-model-a"]).toBeUndefined();
      expect(snap.live[FRAUD_DRIFT_LIMITS.OVERFLOW_VERSION_KEY]).toBeDefined();
      expect(snap.live[FRAUD_DRIFT_LIMITS.OVERFLOW_VERSION_KEY]["3"]).toBe(1);
      expect(snap.liveTotals[FRAUD_DRIFT_LIMITS.OVERFLOW_VERSION_KEY]).toBe(1);

      // 10th distinct version also accumulates under __overflow__
      recordFraudScore("overflow-model-b", 7);
      snap = getFraudDriftSnapshot();
      expect(snap.live[FRAUD_DRIFT_LIMITS.OVERFLOW_VERSION_KEY]["3"]).toBe(1);
      expect(snap.live[FRAUD_DRIFT_LIMITS.OVERFLOW_VERSION_KEY]["7"]).toBe(1);
      expect(snap.liveTotals[FRAUD_DRIFT_LIMITS.OVERFLOW_VERSION_KEY]).toBe(2);
    });

    it("allows already-known versions to continue recording after overflow occurred", () => {
      const max = FRAUD_DRIFT_LIMITS.MAX_MODEL_VERSIONS;
      for (let i = 0; i < max; i++) {
        recordFraudScore(`v${i}`, 0);
      }
      recordFraudScore("excess-v", 9); // causes overflow

      // Record to v0 again
      recordFraudScore("v0", 5);

      const snap = getFraudDriftSnapshot();
      expect(snap.live["v0"]["0"]).toBe(1);
      expect(snap.live["v0"]["5"]).toBe(1);
      expect(snap.liveTotals["v0"]).toBe(2);
    });

    it("preserves versions known through baseline from being marked as overflow", () => {
      setFraudScoreBaseline("baseline-first", { "0": 50 });

      // Fill remaining 7 slots in live
      for (let i = 0; i < 7; i++) {
        recordFraudScore(`v${i}`, 1);
      }

      // Record score for baseline-first (should be recognized and not overflow)
      recordFraudScore("baseline-first", 2);

      const snap = getFraudDriftSnapshot();
      expect(snap.overflowed).toBe(false);
      expect(snap.live["baseline-first"]).toBeDefined();
      expect(snap.live["baseline-first"]["2"]).toBe(1);
    });

    it("resets overflowed flag and overflow version set on resetFraudDriftState", () => {
      const max = FRAUD_DRIFT_LIMITS.MAX_MODEL_VERSIONS;
      for (let i = 0; i < max; i++) {
        recordFraudScore(`v${i}`, 0);
      }
      recordFraudScore("overflow-1", 1);
      expect(getFraudDriftSnapshot().overflowed).toBe(true);

      resetFraudDriftState();

      const snap = getFraudDriftSnapshot();
      expect(snap.overflowed).toBe(false);
      expect(snap.versions).toEqual([]);
    });
  });

  // =========================================================================
  // 7. State Transitions: clearBaseline, clearFraudDriftState, Model Swaps
  // =========================================================================
  describe("primary state transitions", () => {
    it("clearBaseline removes baseline and baselineTotals while preserving live state", () => {
      setFraudScoreBaseline("v1", { "0": 100, "1": 50 });
      recordFraudScore("v1", 0);

      clearBaseline("v1");

      const snap = getFraudDriftSnapshot();
      expect(snap.baseline["v1"]).toBeUndefined();
      expect(snap.baselineTotals["v1"]).toBeUndefined();
      expect(snap.live["v1"]).toBeDefined();
      expect(snap.live["v1"]["0"]).toBe(1);
      expect(snap.liveTotals["v1"]).toBe(1);
    });

    it("clearBaseline on a non-existent version is a safe no-op", () => {
      expect(() => clearBaseline("non-existent")).not.toThrow();
      expect(getFraudDriftSnapshot().versions).toEqual([]);
    });

    it("clearBaseline with invalid version key maps to __none__", () => {
      // @ts-expect-error test invalid input
      setFraudScoreBaseline(null, { "0": 50 });
      expect(getFraudDriftSnapshot().baseline["__none__"]).toBeDefined();

      // @ts-expect-error test invalid input
      clearBaseline(null);
      expect(getFraudDriftSnapshot().baseline["__none__"]).toBeUndefined();
    });

    it("clearFraudDriftState drops all state (live, baseline, totals) for specified version", () => {
      setFraudScoreBaseline("v1", { "0": 100 });
      recordFraudScore("v1", 3);

      setFraudScoreBaseline("v2", { "1": 200 });
      recordFraudScore("v2", 4);

      clearFraudDriftState("v1");

      const snap = getFraudDriftSnapshot();
      expect(snap.live["v1"]).toBeUndefined();
      expect(snap.baseline["v1"]).toBeUndefined();
      expect(snap.liveTotals["v1"]).toBeUndefined();
      expect(snap.baselineTotals["v1"]).toBeUndefined();
      expect(snap.versions).toEqual(["v2"]);

      // v2 remains unaffected
      expect(snap.live["v2"]).toBeDefined();
      expect(snap.baseline["v2"]).toBeDefined();
      expect(snap.liveTotals["v2"]).toBe(1);
      expect(snap.baselineTotals["v2"]).toBe(200);
    });

    it("clearFraudDriftState on a non-existent version is a safe no-op", () => {
      expect(() => clearFraudDriftState("ghost-version")).not.toThrow();
    });

    it("clearFraudDriftState with invalid version key clears __none__", () => {
      // @ts-expect-error test invalid input
      recordFraudScore(undefined, 2);
      expect(getFraudDriftSnapshot().live["__none__"]).toBeDefined();

      // @ts-expect-error test invalid input
      clearFraudDriftState(undefined);
      expect(getFraudDriftSnapshot().live["__none__"]).toBeUndefined();
      expect(getFraudDriftSnapshot().liveTotals["__none__"]).toBeUndefined();
    });

    it("supports full model version swap lifecycle", () => {
      // Step 1: Initial deployment of modelA
      setFraudScoreBaseline("modelA", { "0": 500, "1": 250 });
      recordFraudScore("modelA", 0);
      recordFraudScore("modelA", 1);

      let snap = getFraudDriftSnapshot();
      expect(snap.versions).toEqual(["modelA"]);
      expect(snap.liveTotals["modelA"]).toBe(2);
      expect(snap.baselineTotals["modelA"]).toBe(750);

      // Step 2: Canary/rollout of modelB alongside modelA
      setFraudScoreBaseline("modelB", { "0": 600, "1": 300 });
      recordFraudScore("modelB", 0);

      snap = getFraudDriftSnapshot();
      expect(snap.versions).toEqual(["modelA", "modelB"]);

      // Step 3: Decommission modelA
      clearFraudDriftState("modelA");

      snap = getFraudDriftSnapshot();
      expect(snap.versions).toEqual(["modelB"]);
      expect(snap.live["modelA"]).toBeUndefined();
      expect(snap.live["modelB"]).toBeDefined();
      expect(snap.baseline["modelB"]).toBeDefined();
      expect(snap.liveTotals["modelB"]).toBe(1);
      expect(snap.baselineTotals["modelB"]).toBe(900);
    });
  });

  // =========================================================================
  // 8. FraudDriftSnapshot Immutability & Contract
  // =========================================================================
  describe("FraudDriftSnapshot structure and snapshot isolation", () => {
    it("includes sorted versions unioned from both live and baseline", () => {
      recordFraudScore("z-live-only", 0);
      setFraudScoreBaseline("a-baseline-only", { "0": 10 });
      recordFraudScore("m-both", 1);
      setFraudScoreBaseline("m-both", { "1": 20 });

      const snap = getFraudDriftSnapshot();
      expect(snap.versions).toEqual(["a-baseline-only", "m-both", "z-live-only"]);
    });

    it("produces shallow clones of live and baseline histograms so mutations do not leak", () => {
      recordFraudScore("v1", 0);
      setFraudScoreBaseline("v1", { "0": 100 });

      const snap1 = getFraudDriftSnapshot();
      // Mutate returned snapshot
      snap1.live["v1"]["0"] = 9999;
      snap1.baseline["v1"]["0"] = 8888;
      snap1.versions.push("injected-version");

      const snap2 = getFraudDriftSnapshot();
      expect(snap2.live["v1"]["0"]).toBe(1);
      expect(snap2.baseline["v1"]["0"]).toBe(100);
      expect(snap2.versions).toEqual(["v1"]);
    });
  });

  // =========================================================================
  // 9. Exported Constants and Limits
  // =========================================================================
  describe("FRAUD_DRIFT_LIMITS exports", () => {
    it("exports correct configuration constants", () => {
      expect(FRAUD_DRIFT_LIMITS.MAX_MODEL_VERSIONS).toBe(8);
      expect(FRAUD_DRIFT_LIMITS.OVERFLOW_VERSION_KEY).toBe("__overflow__");
      expect(FRAUD_DRIFT_LIMITS.SCORE_BINS).toEqual(SCORE_BINS);
    });
  });
});
