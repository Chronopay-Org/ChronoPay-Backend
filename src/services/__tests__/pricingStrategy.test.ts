import {
  fixedStrategy,
  timeDecayStrategy,
  demandBasedStrategy,
  getStrategy,
  resolvePrice,
  DECAY_WINDOW_MS,
  DECAY_FLOOR_RATIO,
  DEMAND_SURCHARGE_PER_INTENT,
  DEMAND_PRICE_CAP_RATIO,
  type PricingInput,
  type StrategyId,
} from "../../services/pricingStrategy.js";

// ─── Shared fixture ───────────────────────────────────────────────────────────

const BASE_INPUT: PricingInput = {
  basePrice: 1000,
  slotStartTime: 1_000_000_000_000,
  nowMs: 1_000_000_000_000 - DECAY_WINDOW_MS, // exactly 24 h before start
  activeIntentCount: 0,
};

// ─── fixedStrategy ────────────────────────────────────────────────────────────

describe("fixedStrategy", () => {
  it("returns basePrice unchanged", () => {
    expect(fixedStrategy({ ...BASE_INPUT, basePrice: 500 })).toBe(500);
  });

  it("returns 0 when basePrice is 0", () => {
    expect(fixedStrategy({ ...BASE_INPUT, basePrice: 0 })).toBe(0);
  });

  it("ignores slotStartTime, nowMs, and activeIntentCount", () => {
    const a = fixedStrategy({ ...BASE_INPUT, slotStartTime: 1, nowMs: 999, activeIntentCount: 99 });
    const b = fixedStrategy({ ...BASE_INPUT, slotStartTime: 9999, nowMs: 1, activeIntentCount: 0 });
    expect(a).toBe(BASE_INPUT.basePrice);
    expect(b).toBe(BASE_INPUT.basePrice);
  });

  it("is a pure function — same inputs always produce same output", () => {
    const input = { ...BASE_INPUT };
    expect(fixedStrategy(input)).toBe(fixedStrategy(input));
  });
});

// ─── timeDecayStrategy ────────────────────────────────────────────────────────

describe("timeDecayStrategy", () => {
  const floor = Math.round(BASE_INPUT.basePrice * DECAY_FLOOR_RATIO); // 500

  it("returns full basePrice when exactly at the decay window boundary", () => {
    // nowMs = slotStartTime - DECAY_WINDOW_MS → ratio = 1 → full price
    const result = timeDecayStrategy(BASE_INPUT);
    expect(result).toBe(BASE_INPUT.basePrice);
  });

  it("returns floor price when slot has already started (nowMs >= slotStartTime)", () => {
    const result = timeDecayStrategy({ ...BASE_INPUT, nowMs: BASE_INPUT.slotStartTime });
    expect(result).toBe(floor);
  });

  it("returns floor price when slot is in the past", () => {
    const result = timeDecayStrategy({ ...BASE_INPUT, nowMs: BASE_INPUT.slotStartTime + 1000 });
    expect(result).toBe(floor);
  });

  it("returns midpoint price when halfway through the decay window", () => {
    const halfWindow = DECAY_WINDOW_MS / 2;
    const nowMs = BASE_INPUT.slotStartTime - halfWindow;
    const result = timeDecayStrategy({ ...BASE_INPUT, nowMs });
    // ratio = 0.5 → price = floor + (base - floor) * 0.5 = 500 + 250 = 750
    expect(result).toBe(750);
  });

  it("returns full price when more than 24 h away", () => {
    const nowMs = BASE_INPUT.slotStartTime - DECAY_WINDOW_MS * 2;
    const result = timeDecayStrategy({ ...BASE_INPUT, nowMs });
    expect(result).toBe(BASE_INPUT.basePrice);
  });

  it("returns floor when basePrice is 0", () => {
    const result = timeDecayStrategy({ ...BASE_INPUT, basePrice: 0, nowMs: BASE_INPUT.slotStartTime });
    expect(result).toBe(0);
  });

  it("is a pure function — same inputs always produce same output", () => {
    const input = { ...BASE_INPUT };
    expect(timeDecayStrategy(input)).toBe(timeDecayStrategy(input));
  });

  it("ignores activeIntentCount", () => {
    const a = timeDecayStrategy({ ...BASE_INPUT, activeIntentCount: 0 });
    const b = timeDecayStrategy({ ...BASE_INPUT, activeIntentCount: 100 });
    expect(a).toBe(b);
  });

  it("rounds to integer", () => {
    // Use a basePrice that would produce a fractional result
    const result = timeDecayStrategy({ ...BASE_INPUT, basePrice: 3, nowMs: BASE_INPUT.slotStartTime - DECAY_WINDOW_MS / 2 });
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ─── demandBasedStrategy ─────────────────────────────────────────────────────

describe("demandBasedStrategy", () => {
  it("returns basePrice when there are no active intents", () => {
    expect(demandBasedStrategy({ ...BASE_INPUT, activeIntentCount: 0 })).toBe(BASE_INPUT.basePrice);
  });

  it("applies 10% surcharge per active intent", () => {
    // 1 intent → 1000 * 1.1 = 1100
    expect(demandBasedStrategy({ ...BASE_INPUT, activeIntentCount: 1 })).toBe(1100);
    // 2 intents → 1000 * 1.2 = 1200
    expect(demandBasedStrategy({ ...BASE_INPUT, activeIntentCount: 2 })).toBe(1200);
  });

  it("caps price at 3× basePrice", () => {
    // 20 intents → 1000 * (1 + 20 * 0.1) = 3000 → exactly at cap
    expect(demandBasedStrategy({ ...BASE_INPUT, activeIntentCount: 20 })).toBe(3000);
    // 100 intents → would be 11000 but capped at 3000
    expect(demandBasedStrategy({ ...BASE_INPUT, activeIntentCount: 100 })).toBe(3000);
  });

  it("treats negative activeIntentCount as 0", () => {
    expect(demandBasedStrategy({ ...BASE_INPUT, activeIntentCount: -5 })).toBe(BASE_INPUT.basePrice);
  });

  it("returns 0 when basePrice is 0", () => {
    expect(demandBasedStrategy({ ...BASE_INPUT, basePrice: 0, activeIntentCount: 10 })).toBe(0);
  });

  it("is a pure function — same inputs always produce same output", () => {
    const input = { ...BASE_INPUT, activeIntentCount: 3 };
    expect(demandBasedStrategy(input)).toBe(demandBasedStrategy(input));
  });

  it("ignores slotStartTime and nowMs", () => {
    const a = demandBasedStrategy({ ...BASE_INPUT, slotStartTime: 1, nowMs: 1, activeIntentCount: 2 });
    const b = demandBasedStrategy({ ...BASE_INPUT, slotStartTime: 9999, nowMs: 9999, activeIntentCount: 2 });
    expect(a).toBe(b);
  });

  it("rounds to integer", () => {
    const result = demandBasedStrategy({ ...BASE_INPUT, basePrice: 3, activeIntentCount: 1 });
    expect(Number.isInteger(result)).toBe(true);
  });

  it("reflects DEMAND_SURCHARGE_PER_INTENT and DEMAND_PRICE_CAP_RATIO constants", () => {
    const intentsToHitCap = Math.ceil((DEMAND_PRICE_CAP_RATIO - 1) / DEMAND_SURCHARGE_PER_INTENT);
    const atCap = demandBasedStrategy({ ...BASE_INPUT, activeIntentCount: intentsToHitCap });
    const overCap = demandBasedStrategy({ ...BASE_INPUT, activeIntentCount: intentsToHitCap + 10 });
    expect(atCap).toBe(overCap); // both should be at cap
  });
});

// ─── getStrategy ─────────────────────────────────────────────────────────────

describe("getStrategy", () => {
  it("returns fixedStrategy for 'fixed'", () => {
    expect(getStrategy("fixed")).toBe(fixedStrategy);
  });

  it("returns timeDecayStrategy for 'time_decay'", () => {
    expect(getStrategy("time_decay")).toBe(timeDecayStrategy);
  });

  it("returns demandBasedStrategy for 'demand_based'", () => {
    expect(getStrategy("demand_based")).toBe(demandBasedStrategy);
  });

  it("throws for an unknown strategy id", () => {
    expect(() => getStrategy("unknown" as StrategyId)).toThrow(/Unknown pricing strategy/);
  });
});

// ─── resolvePrice ─────────────────────────────────────────────────────────────

describe("resolvePrice", () => {
  it("returns a PricingResult with strategyId, resolvedPrice, and snapshot", () => {
    const result = resolvePrice("fixed", BASE_INPUT);
    expect(result.strategyId).toBe("fixed");
    expect(result.resolvedPrice).toBe(BASE_INPUT.basePrice);
    expect(result.snapshot).toEqual(BASE_INPUT);
  });

  it("snapshot is a copy — mutating input after call does not affect snapshot", () => {
    const input: PricingInput = { ...BASE_INPUT };
    const result = resolvePrice("fixed", input);
    input.basePrice = 99999;
    expect(result.snapshot.basePrice).toBe(BASE_INPUT.basePrice);
  });

  it("throws RangeError when basePrice is negative", () => {
    expect(() => resolvePrice("fixed", { ...BASE_INPUT, basePrice: -1 })).toThrow(RangeError);
  });

  it("throws for unknown strategyId", () => {
    expect(() => resolvePrice("unknown" as StrategyId, BASE_INPUT)).toThrow(/Unknown pricing strategy/);
  });

  it("resolves time_decay correctly via resolvePrice", () => {
    const result = resolvePrice("time_decay", BASE_INPUT);
    expect(result.strategyId).toBe("time_decay");
    expect(result.resolvedPrice).toBe(BASE_INPUT.basePrice); // full price at 24 h boundary
  });

  it("resolves demand_based correctly via resolvePrice", () => {
    const result = resolvePrice("demand_based", { ...BASE_INPUT, activeIntentCount: 1 });
    expect(result.strategyId).toBe("demand_based");
    expect(result.resolvedPrice).toBe(1100);
  });

  it("is deterministic — same inputs always produce same result", () => {
    const r1 = resolvePrice("time_decay", BASE_INPUT);
    const r2 = resolvePrice("time_decay", BASE_INPUT);
    expect(r1.resolvedPrice).toBe(r2.resolvedPrice);
    expect(r1.strategyId).toBe(r2.strategyId);
  });

  it("accepts basePrice of 0", () => {
    const result = resolvePrice("fixed", { ...BASE_INPUT, basePrice: 0 });
    expect(result.resolvedPrice).toBe(0);
  });

  it("includes all input fields in snapshot", () => {
    const input: PricingInput = {
      basePrice: 500,
      slotStartTime: 2_000_000_000_000,
      nowMs: 1_999_000_000_000,
      activeIntentCount: 3,
    };
    const result = resolvePrice("demand_based", input);
    expect(result.snapshot).toEqual(input);
  });
});
