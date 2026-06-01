/**
 * Dynamic Pricing Strategy Resolver
 *
 * Strategies are pure functions of their inputs — given the same inputs they
 * always return the same price (deterministic / snapshot-safe).
 *
 * Supported strategies:
 *   fixed        – always returns the configured base price
 *   time_decay   – price decreases linearly as the slot start time approaches
 *   demand_based – price scales with the ratio of active bookings to capacity
 */

// ─── Core types ───────────────────────────────────────────────────────────────

/** Identifier for a registered pricing strategy. */
export type StrategyId = "fixed" | "time_decay" | "demand_based";

/** Inputs that every strategy receives. */
export interface PricingInput {
  /** Base price in the smallest currency unit (e.g. stroops or cents). Must be ≥ 0. */
  basePrice: number;
  /** Unix epoch milliseconds when the slot starts. */
  slotStartMs: number;
  /** Unix epoch milliseconds at the moment of resolution (i.e. "now"). */
  nowMs: number;
  /** Number of active (pending/confirmed) booking intents for this slot. */
  activeBookings: number;
  /** Maximum bookings the slot can hold (capacity). Must be ≥ 1. */
  capacity: number;
  /** Strategy-specific configuration (validated per strategy). */
  config: StrategyConfig;
}

/** Union of all per-strategy configuration shapes. */
export type StrategyConfig = FixedConfig | TimeDecayConfig | DemandBasedConfig;

export interface FixedConfig {
  strategy: "fixed";
}

export interface TimeDecayConfig {
  strategy: "time_decay";
  /**
   * Window in milliseconds before slot start during which decay applies.
   * Outside this window the full base price is charged.
   * Must be > 0.
   */
  windowMs: number;
  /**
   * Minimum multiplier (0–1) applied at the moment the slot starts.
   * e.g. 0.5 means the price halves at start time.
   */
  minMultiplier: number;
}

export interface DemandBasedConfig {
  strategy: "demand_based";
  /**
   * Maximum multiplier applied when the slot is fully booked.
   * Must be ≥ 1.
   */
  maxMultiplier: number;
}

/** Result returned by every strategy. */
export interface PricingResult {
  /** Resolved price (rounded to nearest integer, ≥ 0). */
  price: number;
  /** Strategy that produced this result — included for auditability. */
  strategyId: StrategyId;
  /** Snapshot of the inputs used to compute the price. */
  snapshot: {
    basePrice: number;
    slotStartMs: number;
    nowMs: number;
    activeBookings: number;
    capacity: number;
    config: StrategyConfig;
  };
}

/** A pricing strategy is a pure function of PricingInput → PricingResult. */
export type PricingStrategy = (input: PricingInput) => PricingResult;

// ─── Validation helpers ───────────────────────────────────────────────────────

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number, got ${value}`);
  }
}

function assertCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`capacity must be an integer ≥ 1, got ${capacity}`);
  }
}

// ─── Strategy implementations ─────────────────────────────────────────────────

/**
 * fixed – price never changes regardless of time or demand.
 */
export const fixedStrategy: PricingStrategy = (input) => {
  assertPositiveFinite(input.basePrice, "basePrice");

  return {
    price: Math.round(input.basePrice),
    strategyId: "fixed",
    snapshot: {
      basePrice: input.basePrice,
      slotStartMs: input.slotStartMs,
      nowMs: input.nowMs,
      activeBookings: input.activeBookings,
      capacity: input.capacity,
      config: input.config,
    },
  };
};

/**
 * time_decay – price decreases linearly from basePrice to
 * basePrice * minMultiplier as nowMs approaches slotStartMs.
 *
 * Outside the decay window (or after slot start) the full base price applies.
 */
export const timeDecayStrategy: PricingStrategy = (input) => {
  assertPositiveFinite(input.basePrice, "basePrice");

  const cfg = input.config as TimeDecayConfig;
  if (!Number.isFinite(cfg.windowMs) || cfg.windowMs <= 0) {
    throw new Error(`time_decay.windowMs must be a positive finite number, got ${cfg.windowMs}`);
  }
  if (!Number.isFinite(cfg.minMultiplier) || cfg.minMultiplier < 0 || cfg.minMultiplier > 1) {
    throw new Error(
      `time_decay.minMultiplier must be in [0, 1], got ${cfg.minMultiplier}`,
    );
  }

  const msUntilStart = input.slotStartMs - input.nowMs;

  let multiplier: number;
  if (msUntilStart >= cfg.windowMs) {
    // Outside the decay window — full price
    multiplier = 1;
  } else if (msUntilStart <= 0) {
    // At or past slot start — minimum price
    multiplier = cfg.minMultiplier;
  } else {
    // Linear interpolation within the window
    const progress = 1 - msUntilStart / cfg.windowMs; // 0 at window start, 1 at slot start
    multiplier = 1 - progress * (1 - cfg.minMultiplier);
  }

  return {
    price: Math.max(0, Math.round(input.basePrice * multiplier)),
    strategyId: "time_decay",
    snapshot: {
      basePrice: input.basePrice,
      slotStartMs: input.slotStartMs,
      nowMs: input.nowMs,
      activeBookings: input.activeBookings,
      capacity: input.capacity,
      config: input.config,
    },
  };
};

/**
 * demand_based – price scales linearly from basePrice (0 bookings) to
 * basePrice * maxMultiplier (fully booked).
 */
export const demandBasedStrategy: PricingStrategy = (input) => {
  assertPositiveFinite(input.basePrice, "basePrice");
  assertCapacity(input.capacity);

  const cfg = input.config as DemandBasedConfig;
  if (!Number.isFinite(cfg.maxMultiplier) || cfg.maxMultiplier < 1) {
    throw new Error(
      `demand_based.maxMultiplier must be a finite number ≥ 1, got ${cfg.maxMultiplier}`,
    );
  }

  const clampedBookings = Math.min(Math.max(0, input.activeBookings), input.capacity);
  const demandRatio = clampedBookings / input.capacity;
  const multiplier = 1 + demandRatio * (cfg.maxMultiplier - 1);

  return {
    price: Math.max(0, Math.round(input.basePrice * multiplier)),
    strategyId: "demand_based",
    snapshot: {
      basePrice: input.basePrice,
      slotStartMs: input.slotStartMs,
      nowMs: input.nowMs,
      activeBookings: input.activeBookings,
      capacity: input.capacity,
      config: input.config,
    },
  };
};

// ─── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY: Record<StrategyId, PricingStrategy> = {
  fixed: fixedStrategy,
  time_decay: timeDecayStrategy,
  demand_based: demandBasedStrategy,
};

/**
 * Resolve a price using the registered strategy identified by `strategyId`.
 *
 * @throws if `strategyId` is not registered.
 */
export function resolvePrice(strategyId: StrategyId, input: PricingInput): PricingResult {
  const strategy = REGISTRY[strategyId];
  if (!strategy) {
    throw new Error(`Unknown pricing strategy: "${strategyId}"`);
  }
  return strategy(input);
}

/** Returns the list of registered strategy identifiers. */
export function listStrategies(): StrategyId[] {
  return Object.keys(REGISTRY) as StrategyId[];
}
