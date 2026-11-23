/**
 * LTR Reranker Service
 *
 * A lightweight linear-model reranker for marketplace search results.
 *
 * Design:
 *   - Loads model weights at construction time (or uses sensible defaults).
 *   - Each slot is scored as dot(weights, features) and re-sorted.
 *   - Hard 5 ms budget: if reranking takes longer, returns original order.
 *   - Cold-start safe: empty features or absent model → no-op.
 *
 * Security:
 *   - Weights and features are validated dimensionally (length === NUM_FEATURES).
 *   - NaN / Infinity features are clamped to 0 to prevent corrupt scores.
 *   - Budget is enforced via process.hrtime() wall-clock measurement.
 */

import {
  DEFAULT_MODEL_WEIGHTS,
  type LtrModelWeights,
  type LtrReranker,
  type RerankResult,
  type SlotFeatureVector,
  NUM_FEATURES,
} from "./types.js";

/**
 * Maximum allowed rerank duration in milliseconds.
 * If the operation exceeds this budget the original ordering is returned.
 */
export const RERANK_BUDGET_MS = 5;

/**
 * Concrete implementation of the LTR reranker using a dot-product linear model.
 *
 * Usage:
 *   const reranker = new SearchLtrReranker(optionalWeights);
 *   const result = reranker.rerank(slotFeatures);
 */
export class SearchLtrReranker implements LtrReranker {
  private readonly weights: number[];
  private readonly version: string;
  private readonly available: boolean;

  /**
   * @param modelWeights - Optional model weights. If omitted or invalid, defaults are used
   *   but `isAvailable()` will return false (graceful degradation).
   */
  constructor(modelWeights?: LtrModelWeights | null) {
    if (modelWeights && this.isValidWeights(modelWeights)) {
      this.weights = modelWeights.weights;
      this.version = modelWeights.version;
      this.available = true;
    } else {
      // Use defaults but mark as unavailable so callers know it's not a trained model
      this.weights = DEFAULT_MODEL_WEIGHTS.weights;
      this.version = DEFAULT_MODEL_WEIGHTS.version;
      this.available = false;
    }
  }

  /**
   * Returns true if the reranker was loaded with valid trained weights.
   */
  public isAvailable(): boolean {
    return this.available;
  }

  /**
   * Rerank a list of slots by their feature vectors.
   *
   * Algorithm:
   *   1. Validate budget start time
   *   2. For each slot, compute score = dot(weights, features)
   *   3. Sort slots by score descending (stable sort to preserve ties)
   *   4. If budget exceeded at any point, return original order
   *
   * @param slots - Slots with feature vectors
   * @returns RerankResult
   */
  public rerank(slots: SlotFeatureVector[]): RerankResult {
    const startTime = process.hrtime.bigint();

    // ── Edge case: empty input ──────────────────────────────────────────
    if (!slots || slots.length === 0) {
      return {
        slotIds: [],
        reranked: false,
        fallbackReason: "empty_input",
        durationMs: 0,
      };
    }

    // ── Edge case: single slot ──────────────────────────────────────────
    if (slots.length === 1) {
      return {
        slotIds: [slots[0].slotId],
        reranked: false,
        fallbackReason: "single_slot",
        durationMs: Number((process.hrtime.bigint() - startTime)) / 1e6,
      };
    }

    // ── Score each slot ─────────────────────────────────────────────────
    const scored: Array<{ slotId: number; score: number }> = [];

    for (const slot of slots) {
      // Budget check
      if (this.isBudgetExceeded(startTime)) {
        return {
          slotIds: slots.map((s) => s.slotId),
          reranked: false,
          fallbackReason: "budget_breach_during_scoring",
          durationMs: Number((process.hrtime.bigint() - startTime)) / 1e6,
        };
      }

      // Safely handle null/undefined slots
      if (!slot || typeof slot !== "object") {
        continue;
      }

      const score = this.computeScore(slot.features);
      scored.push({ slotId: slot.slotId, score });
    }

    // ── Sort by score descending, stable ────────────────────────────────
    // Use a stable sort: equal scores preserve original order
    const sorted = [...scored].sort((a, b) => {
      // Budget check during sort (comparator can be called many times)
      if (this.isBudgetExceeded(startTime)) {
        // Signal to caller via a flag we'll check after sort
        return 0; // don't reorder — we'll catch the breach below
      }
      return b.score - a.score;
    });

    // Final budget check after sort
    if (this.isBudgetExceeded(startTime)) {
      return {
        slotIds: slots.map((s) => s.slotId),
        reranked: false,
        fallbackReason: "budget_breach_during_sort",
        durationMs: Number((process.hrtime.bigint() - startTime)) / 1e6,
      };
    }

    const slotIds = sorted.map((s) => s.slotId);

    // ── Verify output integrity ─────────────────────────────────────────
    if (scored.length !== slots.length) {
      return {
        slotIds: slots.filter((s) => s && typeof s === "object").map((s) => s.slotId),
        reranked: false,
        fallbackReason: "output_length_mismatch",
        durationMs: Number((process.hrtime.bigint() - startTime)) / 1e6,
      };
    }

    if (slotIds.length !== slots.length) {
      return {
        slotIds: slots.filter((s) => s && typeof s === "object").map((s) => s.slotId),
        reranked: false,
        fallbackReason: "output_length_mismatch",
        durationMs: Number((process.hrtime.bigint() - startTime)) / 1e6,
      };
    }

    const durationMs = Number((process.hrtime.bigint() - startTime)) / 1e6;

    return {
      slotIds,
      reranked: this.available,
      durationMs,
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Compute the dot product of weights and features.
   * Clamps NaN/Infinity feature values to 0 for robustness.
   */
  private computeScore(features: number[]): number {
    if (!features || features.length !== this.weights.length) {
      return 0;
    }

    let score = 0;
    for (let i = 0; i < this.weights.length; i++) {
      const feature = sanitizeFeature(features[i]);
      score += this.weights[i] * feature;
    }

    return score;
  }

  /**
   * Check whether the elapsed time exceeds the budget.
   */
  private isBudgetExceeded(startTime: bigint): boolean {
    const elapsedMs = Number((process.hrtime.bigint() - startTime)) / 1e6;
    return elapsedMs > RERANK_BUDGET_MS;
  }

  /**
   * Validate that model weights conform to the expected shape.
   */
  private isValidWeights(weights: LtrModelWeights): boolean {
    if (!weights || typeof weights !== "object") return false;
    if (!Array.isArray(weights.weights)) return false;
    if (weights.weights.length !== NUM_FEATURES) return false;
    // All weights must be finite numbers
    return weights.weights.every((w) => typeof w === "number" && Number.isFinite(w));
  }
}

// ─── Utility ───────────────────────────────────────────────────────────────

/**
 * Sanitize a single feature value:
 *   - If NaN or Infinity → 0
 *   - Otherwise return as-is
 */
export function sanitizeFeature(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return value;
}
