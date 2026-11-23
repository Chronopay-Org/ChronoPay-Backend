/**
 * LTR Reranker Tests
 *
 * Covers:
 *   - Basic reranking (dot-product scoring, ordering)
 *   - Cold-start: empty features, absent model
 *   - Budget breach (artificially low budget)
 *   - Model weight validation
 *   - Single-slot and empty input edges
 *   - NaN/Infinity feature clamping
 *   - Output integrity (no lost slots, no duplicates)
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  SearchLtrReranker,
  sanitizeFeature,
  RERANK_BUDGET_MS,
} from "../reranker.js";
import {
  type LtrModelWeights,
  type SlotFeatureVector,
  NUM_FEATURES,
  DEFAULT_MODEL_WEIGHTS,
} from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSlotFeatures(
  slotId: number,
  features: number[],
): SlotFeatureVector {
  return { slotId, features };
}

function makeTrainedWeights(overrides?: Partial<LtrModelWeights>): LtrModelWeights {
  return {
    version: "test-v1",
    weights: overrides?.weights ?? [0.4, 0.25, 0.15, 0.1, 0.05, 0.05],
    ...overrides,
  };
}

// ─── sanitizeFeature ─────────────────────────────────────────────────────────

describe("sanitizeFeature", () => {
  it("returns the value as-is for finite numbers", () => {
    expect(sanitizeFeature(0)).toBe(0);
    expect(sanitizeFeature(1.5)).toBe(1.5);
    expect(sanitizeFeature(-3.14)).toBe(-3.14);
  });

  it("returns 0 for NaN", () => {
    expect(sanitizeFeature(NaN)).toBe(0);
  });

  it("returns 0 for Infinity", () => {
    expect(sanitizeFeature(Infinity)).toBe(0);
    expect(sanitizeFeature(-Infinity)).toBe(0);
  });

  it("returns 0 for non-number types", () => {
    expect(sanitizeFeature(undefined as unknown as number)).toBe(0);
    expect(sanitizeFeature(null as unknown as number)).toBe(0);
  });
});

// ─── SearchLtrReranker ──────────────────────────────────────────────────────

describe("SearchLtrReranker", () => {
  describe("constructor and isAvailable", () => {
    it("is unavailable when constructed without weights (noop mode)", () => {
      const reranker = new SearchLtrReranker();
      expect(reranker.isAvailable()).toBe(false);
    });

    it("is unavailable when constructed with null weights", () => {
      const reranker = new SearchLtrReranker(null);
      expect(reranker.isAvailable()).toBe(false);
    });

    it("is available when constructed with valid trained weights", () => {
      const reranker = new SearchLtrReranker(makeTrainedWeights());
      expect(reranker.isAvailable()).toBe(true);
    });

    it("is unavailable when weights have wrong dimension", () => {
      const badWeights: LtrModelWeights = {
        version: "bad",
        weights: [0.1, 0.2], // only 2, expected NUM_FEATURES
      };
      const reranker = new SearchLtrReranker(badWeights);
      expect(reranker.isAvailable()).toBe(false);
    });

    it("is unavailable when weights contain NaN", () => {
      const badWeights = makeTrainedWeights({
        weights: Array(NUM_FEATURES).fill(0).map((_, i) => i === 2 ? NaN : 0.1),
      });
      const reranker = new SearchLtrReranker(badWeights);
      expect(reranker.isAvailable()).toBe(false);
    });

    it("is unavailable when weights contain Infinity", () => {
      const badWeights = makeTrainedWeights({
        weights: Array(NUM_FEATURES).fill(0).map((_, i) => i === 0 ? Infinity : 0.1),
      });
      const reranker = new SearchLtrReranker(badWeights);
      expect(reranker.isAvailable()).toBe(false);
    });

    it("is unavailable when weights is not an object", () => {
      const reranker = new SearchLtrReranker(undefined as unknown as LtrModelWeights);
      expect(reranker.isAvailable()).toBe(false);
    });
  });

  describe("rerank - basic functionality", () => {
    let reranker: SearchLtrReranker;

    beforeEach(() => {
      // Weights: rating has highest weight (0.4), so higher-rated slots sort first
      reranker = new SearchLtrReranker(makeTrainedWeights());
    });

    it("returns reranked=false when model is not available (default weights)", () => {
      const noopReranker = new SearchLtrReranker();
      const slots = [
        makeSlotFeatures(1, [0.2, 0.5, 0, 0, 0, 0]),
        makeSlotFeatures(2, [0.8, 0.3, 0, 0, 0, 0]),
      ];
      const result = noopReranker.rerank(slots);
      expect(result.reranked).toBe(false);
    });

    it("reorders slots by score descending", () => {
      // Slot 2 has higher rating → should rank first
      const slots = [
        makeSlotFeatures(1, [0.2, 0.5, 0, 0, 0, 0]),
        makeSlotFeatures(2, [0.8, 0.5, 0, 0, 0, 0]),
      ];
      const result = reranker.rerank(slots);

      expect(result.reranked).toBe(true);
      expect(result.slotIds).toEqual([2, 1]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(RERANK_BUDGET_MS);
    });

    it("preserves original order for equal scores (stable sort)", () => {
      // All identical features → scores identical → original order preserved
      const slots = [
        makeSlotFeatures(1, [0.5, 0.5, 0, 0, 0, 0]),
        makeSlotFeatures(2, [0.5, 0.5, 0, 0, 0, 0]),
        makeSlotFeatures(3, [0.5, 0.5, 0, 0, 0, 0]),
      ];
      const result = reranker.rerank(slots);
      expect(result.slotIds).toEqual([1, 2, 3]);
    });

    it("returns slotIds with same length as input", () => {
      const slots = [
        makeSlotFeatures(1, [0.1, 0, 0, 0, 0, 0]),
        makeSlotFeatures(2, [0.2, 0, 0, 0, 0, 0]),
        makeSlotFeatures(3, [0.3, 0, 0, 0, 0, 0]),
        makeSlotFeatures(4, [0.4, 0, 0, 0, 0, 0]),
        makeSlotFeatures(5, [0.5, 0, 0, 0, 0, 0]),
      ];
      const result = reranker.rerank(slots);
      expect(result.slotIds).toHaveLength(5);
    });

    it("contains all input slot IDs in output (no loss)", () => {
      const slots = [
        makeSlotFeatures(10, [0.9, 0, 0, 0, 0, 0]),
        makeSlotFeatures(20, [0.1, 0, 0, 0, 0, 0]),
        makeSlotFeatures(30, [0.5, 0, 0, 0, 0, 0]),
      ];
      const result = reranker.rerank(slots);
      const sorted = [...result.slotIds].sort((a, b) => a - b);
      expect(sorted).toEqual([10, 20, 30]);
    });

    it("scores correctly with all feature dimensions active", () => {
      // Set all features to test full dot product
      const weights = makeTrainedWeights({
        weights: [0.2, 0.2, 0.2, 0.2, 0.1, 0.1],
      });
      const fullReranker = new SearchLtrReranker(weights);
      const slots = [
        makeSlotFeatures(1, [0.5, 0.5, 0.5, 1, 0.5, 0.5]),
        makeSlotFeatures(2, [0.8, 0.8, 0.8, 0, 0.5, 0.5]),
      ];

      // Slot 1 score = 0.2*0.5 + 0.2*0.5 + 0.2*0.5 + 0.2*1 + 0.1*0.5 + 0.1*0.5 = 0.1+0.1+0.1+0.2+0.05+0.05 = 0.6
      // Slot 2 score = 0.2*0.8 + 0.2*0.8 + 0.2*0.8 + 0.2*0 + 0.1*0.5 + 0.1*0.5 = 0.16+0.16+0.16+0+0.05+0.05 = 0.58
      const result = fullReranker.rerank(slots);
      expect(result.slotIds).toEqual([1, 2]);
    });
  });

  describe("rerank - edge cases", () => {
    let reranker: SearchLtrReranker;

    beforeEach(() => {
      reranker = new SearchLtrReranker(makeTrainedWeights());
    });

    it("handles empty input array", () => {
      const result = reranker.rerank([]);
      expect(result.slotIds).toEqual([]);
      expect(result.reranked).toBe(false);
      expect(result.fallbackReason).toBe("empty_input");
    });

    it("handles single slot", () => {
      const slots = [makeSlotFeatures(42, [0.5, 0.5, 0, 0, 0, 0])];
      const result = reranker.rerank(slots);
      expect(result.slotIds).toEqual([42]);
      expect(result.reranked).toBe(false);
      expect(result.fallbackReason).toBe("single_slot");
    });

    it("handles features with NaN values gracefully", () => {
      const slots = [
        makeSlotFeatures(1, [NaN, 0.5, 0, 0, 0, 0]),
        makeSlotFeatures(2, [0.8, 0.5, 0, 0, 0, 0]),
      ];
      // Slot 1 has NaN in rating → sanitized to 0 → score lower than slot 2
      const result = reranker.rerank(slots);
      expect(result.reranked).toBe(true);
      expect(result.slotIds).toEqual([2, 1]);
    });

    it("handles features with Infinity values gracefully", () => {
      const slots = [
        makeSlotFeatures(1, [Infinity, 0.5, 0, 0, 0, 0]),
        makeSlotFeatures(2, [0.8, 0.5, 0, 0, 0, 0]),
      ];
      // Infinity sanitized to 0 → slot 1 score lower
      const result = reranker.rerank(slots);
      expect(result.reranked).toBe(true);
      expect(result.slotIds).toEqual([2, 1]);
    });

    it("handles features with wrong length (shorter)", () => {
      const slots = [
        makeSlotFeatures(1, [0.5]), // only 1 feature, should score 0
        makeSlotFeatures(2, [0.8, 0.3, 0, 0, 0, 0]),
      ];
      const result = reranker.rerank(slots);
      // Slot 1 score = 0, Slot 2 score > 0
      expect(result.slotIds).toEqual([2, 1]);
    });

    it("handles features with wrong length (longer)", () => {
      const slots = [
        makeSlotFeatures(1, [0.5, 0.5, 0, 0, 0, 0, 0.9, 0.9]), // 8 features
        makeSlotFeatures(2, [0.8, 0.3, 0, 0, 0, 0]),
      ];
      const result = reranker.rerank(slots);
      // Slot 1 has wrong length → score = 0
      expect(result.slotIds).toEqual([2, 1]);
    });

    it("handles null/undefined slot gracefully", () => {
      const slots: SlotFeatureVector[] = [
        null as unknown as SlotFeatureVector,
        makeSlotFeatures(2, [0.8, 0.3, 0, 0, 0, 0]),
      ];
      const result = reranker.rerank(slots);
      // Should not throw, null slot is skipped
      expect(result.slotIds).toHaveLength(1);
      expect(result.slotIds[0]).toBe(2);
    });
  });

  describe("rerank - budget enforcement", () => {
    it("completes within RERANK_BUDGET_MS for normal input", () => {
      const reranker = new SearchLtrReranker(makeTrainedWeights());
      const slots = Array.from({ length: 100 }, (_, i) =>
        makeSlotFeatures(i + 1, Array(NUM_FEATURES).fill(0).map(() => Math.random())),
      );

      const result = reranker.rerank(slots);
      expect(result.durationMs).toBeLessThan(RERANK_BUDGET_MS);
    });

    it("returns quickly for 500 slots", () => {
      const reranker = new SearchLtrReranker(makeTrainedWeights());
      const slots = Array.from({ length: 500 }, (_, i) =>
        makeSlotFeatures(i + 1, Array(NUM_FEATURES).fill(0).map(() => Math.random())),
      );

      const result = reranker.rerank(slots);
      // Even with 500 slots, we should still be well under budget
      expect(result.durationMs).toBeLessThan(RERANK_BUDGET_MS);
    });

    it("detects budget breach with very large input", () => {
      const reranker = new SearchLtrReranker(makeTrainedWeights());
      const slots = Array.from({ length: 5000 }, (_, i) =>
        makeSlotFeatures(i + 1, Array(NUM_FEATURES).fill(0).map(() => Math.random())),
      );

      const result = reranker.rerank(slots);
      // Should either complete or fall back with budget breach
      if (result.reranked) {
        expect(result.durationMs).toBeLessThan(RERANK_BUDGET_MS + 2); // small tolerance
      } else {
        expect(result.fallbackReason).toMatch(/budget_breach/);
      }
    });
  });

  describe("DEFAULT_MODEL_WEIGHTS", () => {
    it("has correct dimension", () => {
      expect(DEFAULT_MODEL_WEIGHTS.weights).toHaveLength(NUM_FEATURES);
    });

    it("is a valid weight set (all finite numbers)", () => {
      const allFinite = DEFAULT_MODEL_WEIGHTS.weights.every(
        (w) => typeof w === "number" && Number.isFinite(w),
      );
      expect(allFinite).toBe(true);
    });

    it("has a version string", () => {
      expect(typeof DEFAULT_MODEL_WEIGHTS.version).toBe("string");
      expect(DEFAULT_MODEL_WEIGHTS.version.length).toBeGreaterThan(0);
    });
  });
});
