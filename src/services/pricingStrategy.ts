/**
 * Dynamic Pricing Strategy Resolver
 *
 * Provides a PricingStrategy interface and three built-in strategies:
 *   - fixed:        always returns the base price unchanged
 *   - time_decay:   price decreases linearly as the slot start time approaches
 *   - demand_based: price increases with the number of active booking intents
 *
 * All strategies are pure functions of their inputs, making resolution
 * deterministic for a given snapshot.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type StrategyId = "fixed" | "time_decay" | "demand_based";

/** Inputs required to resolve a price. All values are snapshotted at call time. */
export interface PricingInput {
  /** Base price in the smallest currency unit (e.g. stroops or cents). Must be ≥ 0. */
  basePrice: number;
  /** Unix epoch milliseconds when the slot starts. */
  slotStartTime: number;
  /** Unix epoch milliseconds at the moment of resolution (i.e. "now"). */
  nowMs: number;
  /**
   * Number of active (pending) booking intents for this slot or professional.
   * Used by demand_based strategy.
   */
  activeIntentCount: number;
}

/** The resolved price result, always including the strategy identifier for auditability. */
export interface PricingResult {
  /** The resolved price in the same unit as basePrice. Always ≥ 0. */
  resolvedPrice: number;
  /** The strategy that produced this price. */
  strategyId: StrategyId;
  /** A copy of the inputs used, for snapshot / audit purposes. */
  snapshot: PricingInput;
}

/** A pricing strategy is a pure function: (input) → resolvedPrice. */
export type PricingStrategy = (input: PricingInput) => number;

// ─── Strategy implementations ─────────────────────────────────────────────────

/**
 * fixed: always returns basePrice regardless of other inputs.
 */
export const fixedStrategy: PricingStrategy = ({ basePrice }) => basePrice;

/**
 * time_decay: linearly reduces price to a floor as the slot start approaches.
 *
 * Formula:
 *   ratio = clamp((slotStartTime - nowMs) / decayWindowMs, 0, 1)
 *   price = floor + (basePrice - floor) * ratio
 *
 * Constants:
 *   decayWindowMs = 24 hours  (full price when ≥ 24 h away)
 *   floor         = 50 % of basePrice
 *
 * When nowMs ≥ slotStartTime the slot has already started; price = floor.
 */
export const DECAY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 h
export const DECAY_FLOOR_RATIO = 0.5; // 50 % floor

export const timeDecayStrategy: PricingStrategy = ({ basePrice, slotStartTime, nowMs }) => {
  const floor = Math.round(basePrice * DECAY_FLOOR_RATIO);
  const msUntilStart = slotStartTime - nowMs;
  const ratio = Math.min(1, Math.max(0, msUntilStart / DECAY_WINDOW_MS));
  return Math.round(floor + (basePrice - floor) * ratio);
};

/**
 * demand_based: increases price with the number of active intents.
 *
 * Formula:
 *   price = basePrice * (1 + activeIntentCount * surchargePerIntent)
 *
 * Constants:
 *   surchargePerIntent = 10 % per active intent
 *   cap                = 3× basePrice
 */
export const DEMAND_SURCHARGE_PER_INTENT = 0.1; // 10 % per intent
export const DEMAND_PRICE_CAP_RATIO = 3.0; // max 3× base

export const demandBasedStrategy: PricingStrategy = ({ basePrice, activeIntentCount }) => {
  const multiplier = 1 + Math.max(0, activeIntentCount) * DEMAND_SURCHARGE_PER_INTENT;
  const cap = basePrice * DEMAND_PRICE_CAP_RATIO;
  return Math.round(Math.min(basePrice * multiplier, cap));
};

// ─── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY: Record<StrategyId, PricingStrategy> = {
  fixed: fixedStrategy,
  time_decay: timeDecayStrategy,
  demand_based: demandBasedStrategy,
};

/**
 * Returns the strategy function for the given id.
 * Throws if the id is not registered (guards against misconfiguration).
 */
export function getStrategy(id: StrategyId): PricingStrategy {
  const strategy = REGISTRY[id];
  if (!strategy) {
    throw new Error(`Unknown pricing strategy: "${id}"`);
  }
  return strategy;
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolves a price using the named strategy and returns a full PricingResult
 * that includes the strategy identifier and a snapshot of the inputs used.
 *
 * The result is deterministic: calling with the same strategyId and input
 * always produces the same resolvedPrice.
 */
export function resolvePrice(strategyId: StrategyId, input: PricingInput): PricingResult {
  if (input.basePrice < 0) {
    throw new RangeError("basePrice must be ≥ 0");
  }
  const strategy = getStrategy(strategyId);
  const resolvedPrice = strategy(input);
  return {
    resolvedPrice,
    strategyId,
    snapshot: { ...input },
  };
}
