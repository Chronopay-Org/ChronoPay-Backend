/**
 * LTR Module Barrel Export
 *
 * Re-exports all public types and implementations for the
 * marketplace search learning-to-rank reranker.
 */

export {
  DEFAULT_MODEL_WEIGHTS,
  NUM_FEATURES,
  type LtrEvent,
  type LtrEventEmitter,
  type LtrModelWeights,
  type LtrReranker,
  type RerankResult,
  type SearchClickEvent,
  type SearchImpressionEvent,
  type SlotFeatureVector,
} from "./types.js";

export {
  RERANK_BUDGET_MS,
  sanitizeFeature,
  SearchLtrReranker,
} from "./reranker.js";

export { NoopLtrEventEmitter, SearchLtrEventEmitter } from "./eventEmitter.js";
