import {
  fixedStrategy,
  timeDecayStrategy,
  demandBasedStrategy,
  resolvePrice,
  listStrategies,
  type PricingInput,
} from "../pricingStrategy.js";

// ─── Shared base input ────────────────────────────────────────────────────────

const BASE: PricingInput = {
  basePrice: 1000,
  slotStartMs: 2_000_000,
  nowMs: 1_000_000,
  activeBookings: 0,
  capacity: 10,
  config: { strategy: "fixed" },
};

// ─── fixedStrategy ────────────────────────────────────────────────────────────

describe("fixedStrategy", () => {
  it("returns basePrice unchanged", () => {
    const r = fixedStrategy({ ...BASE, config: { strategy: "fixed" } });
    expect(r.price).toBe(1000);
    expect(r.strategyId).toBe("fixed");
  });

  it("rounds fractional basePrice", () => {
    const r = fixedStrategy({ ...BASE, basePrice: 999.6, config: { strategy: "fixed" } });
    expect(r.price).toBe(1000);
  });

  it("returns 0 for basePrice 0", () => {
    const r = fixedStrategy({ ...BASE, basePrice: 0, config: { strategy: "fixed" } });
    expect(r.price).toBe(0);
  });

  it("snapshot contains all inputs", () => {
    const input = { ...BASE, config: { strategy: "fixed" as const } };
    const r = fixedStrategy(input);
    expect(r.snapshot.basePrice).toBe(input.basePrice);
    expect(r.snapshot.slotStartMs).toBe(input.slotStartMs);
    expect(r.snapshot.nowMs).toBe(input.nowMs);
    expect(r.snapshot.activeBookings).toBe(input.activeBookings);
    expect(r.snapshot.capacity).toBe(input.capacity);
    expect(r.snapshot.config).toEqual(input.config);
  });

  it("is deterministic — same inputs produce same output", () => {
    const input = { ...BASE, config: { strategy: "fixed" as const } };
    expect(fixedStrategy(input)).toEqual(fixedStrategy(input));
  });

  it("throws for negative basePrice", () => {
    expect(() => fixedStrategy({ ...BASE, basePrice: -1, config: { strategy: "fixed" } })).toThrow();
  });

  it("throws for NaN basePrice", () => {
    expect(() => fixedStrategy({ ...BASE, basePrice: NaN, config: { strategy: "fixed" } })).toThrow();
  });
});

// ─── timeDecayStrategy ────────────────────────────────────────────────────────

describe("timeDecayStrategy", () => {
  const cfg = { strategy: "time_decay" as const, windowMs: 1_000_000, minMultiplier: 0.5 };

  it("returns full price outside the decay window", () => {
    // nowMs is exactly at window start (slotStart - windowMs)
    const r = timeDecayStrategy({ ...BASE, nowMs: 1_000_000, slotStartMs: 2_000_000, config: cfg });
    expect(r.price).toBe(1000);
    expect(r.strategyId).toBe("time_decay");
  });

  it("returns minMultiplier price at slot start", () => {
    const r = timeDecayStrategy({ ...BASE, nowMs: 2_000_000, slotStartMs: 2_000_000, config: cfg });
    expect(r.price).toBe(500); // 1000 * 0.5
  });

  it("returns minMultiplier price after slot start", () => {
    const r = timeDecayStrategy({ ...BASE, nowMs: 3_000_000, slotStartMs: 2_000_000, config: cfg });
    expect(r.price).toBe(500);
  });

  it("interpolates linearly at midpoint of window", () => {
    // 500_000 ms before start = halfway through window → multiplier = 0.75
    const r = timeDecayStrategy({ ...BASE, nowMs: 1_500_000, slotStartMs: 2_000_000, config: cfg });
    expect(r.price).toBe(750); // 1000 * 0.75
  });

  it("is deterministic", () => {
    const input = { ...BASE, config: cfg };
    expect(timeDecayStrategy(input)).toEqual(timeDecayStrategy(input));
  });

  it("snapshot contains all inputs", () => {
    const input = { ...BASE, config: cfg };
    const r = timeDecayStrategy(input);
    expect(r.snapshot.config).toEqual(cfg);
  });

  it("throws for windowMs <= 0", () => {
    expect(() =>
      timeDecayStrategy({ ...BASE, config: { strategy: "time_decay", windowMs: 0, minMultiplier: 0.5 } }),
    ).toThrow();
  });

  it("throws for minMultiplier > 1", () => {
    expect(() =>
      timeDecayStrategy({ ...BASE, config: { strategy: "time_decay", windowMs: 1000, minMultiplier: 1.1 } }),
    ).toThrow();
  });

  it("throws for minMultiplier < 0", () => {
    expect(() =>
      timeDecayStrategy({ ...BASE, config: { strategy: "time_decay", windowMs: 1000, minMultiplier: -0.1 } }),
    ).toThrow();
  });

  it("allows minMultiplier = 0 (free at start)", () => {
    const r = timeDecayStrategy({
      ...BASE,
      nowMs: 2_000_000,
      slotStartMs: 2_000_000,
      config: { strategy: "time_decay", windowMs: 1_000_000, minMultiplier: 0 },
    });
    expect(r.price).toBe(0);
  });

  it("price never goes below 0", () => {
    const r = timeDecayStrategy({
      ...BASE,
      basePrice: 1,
      nowMs: 5_000_000,
      slotStartMs: 2_000_000,
      config: { strategy: "time_decay", windowMs: 1_000_000, minMultiplier: 0 },
    });
    expect(r.price).toBeGreaterThanOrEqual(0);
  });
});

// ─── demandBasedStrategy ──────────────────────────────────────────────────────

describe("demandBasedStrategy", () => {
  const cfg = { strategy: "demand_based" as const, maxMultiplier: 2 };

  it("returns basePrice when no bookings", () => {
    const r = demandBasedStrategy({ ...BASE, activeBookings: 0, capacity: 10, config: cfg });
    expect(r.price).toBe(1000);
    expect(r.strategyId).toBe("demand_based");
  });

  it("returns basePrice * maxMultiplier when fully booked", () => {
    const r = demandBasedStrategy({ ...BASE, activeBookings: 10, capacity: 10, config: cfg });
    expect(r.price).toBe(2000);
  });

  it("interpolates at 50% capacity", () => {
    const r = demandBasedStrategy({ ...BASE, activeBookings: 5, capacity: 10, config: cfg });
    expect(r.price).toBe(1500); // 1000 * 1.5
  });

  it("clamps activeBookings above capacity", () => {
    const r = demandBasedStrategy({ ...BASE, activeBookings: 20, capacity: 10, config: cfg });
    expect(r.price).toBe(2000);
  });

  it("clamps negative activeBookings to 0", () => {
    const r = demandBasedStrategy({ ...BASE, activeBookings: -5, capacity: 10, config: cfg });
    expect(r.price).toBe(1000);
  });

  it("is deterministic", () => {
    const input = { ...BASE, config: cfg };
    expect(demandBasedStrategy(input)).toEqual(demandBasedStrategy(input));
  });

  it("snapshot contains all inputs", () => {
    const input = { ...BASE, config: cfg };
    const r = demandBasedStrategy(input);
    expect(r.snapshot.activeBookings).toBe(input.activeBookings);
    expect(r.snapshot.capacity).toBe(input.capacity);
  });

  it("throws for maxMultiplier < 1", () => {
    expect(() =>
      demandBasedStrategy({ ...BASE, config: { strategy: "demand_based", maxMultiplier: 0.9 } }),
    ).toThrow();
  });

  it("throws for capacity < 1", () => {
    expect(() =>
      demandBasedStrategy({ ...BASE, capacity: 0, config: cfg }),
    ).toThrow();
  });

  it("throws for non-integer capacity", () => {
    expect(() =>
      demandBasedStrategy({ ...BASE, capacity: 1.5, config: cfg }),
    ).toThrow();
  });
});

// ─── resolvePrice ─────────────────────────────────────────────────────────────

describe("resolvePrice", () => {
  it("dispatches to fixed strategy", () => {
    const r = resolvePrice("fixed", { ...BASE, config: { strategy: "fixed" } });
    expect(r.strategyId).toBe("fixed");
    expect(r.price).toBe(1000);
  });

  it("dispatches to time_decay strategy", () => {
    const r = resolvePrice("time_decay", {
      ...BASE,
      config: { strategy: "time_decay", windowMs: 1_000_000, minMultiplier: 0.5 },
    });
    expect(r.strategyId).toBe("time_decay");
  });

  it("dispatches to demand_based strategy", () => {
    const r = resolvePrice("demand_based", {
      ...BASE,
      config: { strategy: "demand_based", maxMultiplier: 3 },
    });
    expect(r.strategyId).toBe("demand_based");
  });

  it("throws for unknown strategyId", () => {
    expect(() => resolvePrice("unknown" as any, BASE)).toThrow(/Unknown pricing strategy/);
  });
});

// ─── listStrategies ───────────────────────────────────────────────────────────

describe("listStrategies", () => {
  it("returns all three registered strategies", () => {
    const ids = listStrategies();
    expect(ids).toContain("fixed");
    expect(ids).toContain("time_decay");
    expect(ids).toContain("demand_based");
    expect(ids).toHaveLength(3);
  });
});
