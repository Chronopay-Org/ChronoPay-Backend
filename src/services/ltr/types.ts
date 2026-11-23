/**
 * Learning-to-Rank (LTR) Types
 *
 * Defines the core data structures for the marketplace search reranker:
 * - Slot feature vectors used as input to the linear model
 * - Model weights loaded at boot
 * - Impression and click events emitted for offline training
 */

// ─── Feature Vector ─────────────────────────────────────────────────────────

/**
 * Numeric feature vector for a single slot.
 * Features are positional: the i-th entry corresponds to the i-th model weight.
 *
 * Feature meanings by position:
 *   0: supplier_rating (normalized 0–1: raw rating / 5)
 *   1: price_cents (normalized 0–1: 1 - min(price, 20000) / 20000, so lower price → higher score)
 *   2: historical_ctr (click-through rate for this slot, 0–1, cold start = 0)
 *   3: category_match (1 if query category matches slot category, 0 otherwise)
 *   4: recency_boost (1 – daysSinceCreation / 30, clamped to [0,1])
 *   5: availability_window (1 if slot is available in near future, decays with distance)
 */
export interface SlotFeatureVector {
  /** Slot identifier */
  slotId: number;
  /** Numeric feature values. Length must equal NUM_FEATURES. */
  features: number[];
}

/**
 * Number of features in the feature vector.
 * Must stay in sync with the weight vector length.
 */
export const NUM_FEATURES = 6;

// ─── Model Weights ──────────────────────────────────────────────────────────

/**
 * Linear model weights loaded at boot.
 * The score for a slot is: dot(weights, features) = sum(weights[i] * features[i]).
 *
 * Default values represent a sensible prior:
 *   - Higher rating → better
 *   - Lower price → better
 *   - Higher historical CTR → better
 *   - Category match → better
 *   - Recency → slightly better
 *   - Availability → slightly better
 */
export interface LtrModelWeights {
  /** Version tag for the weight set (e.g., "2026-07-28-v1") */
  version: string;
  /** Weight values; length must equal NUM_FEATURES */
  weights: number[];
}

/**
 * Default model weights used when no weight file is loaded.
 * These are sensible priors that preserve the original ranking order.
 */
export const DEFAULT_MODEL_WEIGHTS: LtrModelWeights = {
  version: "default-v0",
  weights: [0.4, 0.25, 0.15, 0.1, 0.05, 0.05],
};

// ─── Impression & Click Events ──────────────────────────────────────────────

/**
 * Emitted when a user performs a search and sees results.
 * Contains the query context and the ranked slot list along with their
 * feature vectors so an offline training pipeline can learn from clicks.
 */
export interface SearchImpressionEvent {
  type: "search_impression";
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Unique identifier for this search session (correlates impression→click) */
  searchId: string;
  /** Opaque identifier for the user (hashed / pseudonymized) */
  userId?: string;
  /** The search query that produced these results */
  query: {
    categories?: string[];
    priceRange?: { min?: number; max?: number };
    ratingRange?: { min?: number; max?: number };
    sortBy: string;
    page: number;
  };
  /** Slots shown, in the order they were displayed */
  displayedSlots: Array<{
    slotId: number;
    features: number[];
  }>;
}

/**
 * Emitted when a user clicks on a slot from the search results.
 * The searchId links back to the corresponding SearchImpressionEvent.
 */
export interface SearchClickEvent {
  type: "search_click";
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Links back to the impression event */
  searchId: string;
  /** The slot that was clicked */
  slotId: number;
  /** Position in the displayed list (0-indexed) */
  position: number;
  /** Opaque identifier for the user (hashed / pseudonymized) */
  userId?: string;
}

/**
 * Union type for any LTR event emitted to the training pipeline.
 */
export type LtrEvent = SearchImpressionEvent | SearchClickEvent;

// ─── Reranker Interface ─────────────────────────────────────────────────────

/**
 * Result of a rerank operation.
 */
export interface RerankResult {
  /** Slot IDs in the new (reranked) order */
  slotIds: number[];
  /** Whether the reranker was active (false means original order returned) */
  reranked: boolean;
  /** Reason for not reranking, if applicable */
  fallbackReason?: string;
  /** Duration of the rerank operation in milliseconds */
  durationMs: number;
}

/**
 * Interface for the LTR reranker.
 * Enables dependency injection for testing.
 */
export interface LtrReranker {
  /**
   * Rerank a list of slots using the learned model.
   *
   * @param slots - Slots with their feature vectors
   * @returns RerankResult with the new ordering and metadata
   */
  rerank(slots: SlotFeatureVector[]): RerankResult;

  /**
   * Whether the reranker has valid model weights loaded.
   */
  isAvailable(): boolean;
}

// ─── Event Emitter Interface ────────────────────────────────────────────────

/**
 * Interface for the LTR event emitter.
 * Enables dependency injection for testing.
 */
export interface LtrEventEmitter {
  /**
   * Emit a search impression event (fire-and-forget).
   *
   * @param event - The impression event to emit
   */
  emitImpression(event: SearchImpressionEvent): void;

  /**
   * Emit a search click event (fire-and-forget).
   *
   * @param event - The click event to emit
   */
  emitClick(event: SearchClickEvent): void;
}
