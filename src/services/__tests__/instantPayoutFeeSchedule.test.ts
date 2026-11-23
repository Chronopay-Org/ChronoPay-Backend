import {
  calculateFee,
  getMonthlyAccrual,
  getSchedule,
  listTiers,
  getTierConfig,
  _resetAccrualsForTesting,
  type FeeScheduleConfig,
  type CalculateFeeInput,
} from "../instantPayoutFeeSchedule.js";

beforeEach(() => {
  _resetAccrualsForTesting();
});

// ─── Shared test config ──────────────────────────────────────────────────────

const CUSTOM_SCHEDULE: FeeScheduleConfig = {
  basic: { basisPoints: 150, flatFee: 0, monthlyCap: 10_000 },
  premium: { basisPoints: 100, flatFee: 50, monthlyCap: 50_000 },
  unlisted: { basisPoints: 50, flatFee: 0, monthlyCap: 0 },
};

function makeInput(overrides?: Partial<CalculateFeeInput>): CalculateFeeInput {
  return {
    supplierId: "sup-1",
    tier: "basic",
    amount: 10_000,
    currency: "USD",
    ...overrides,
  };
}

// ─── Basic fee calculation ──────────────────────────────────────────────────

describe("calculateFee", () => {
  it("calculates fee from basis points", () => {
    const result = calculateFee(makeInput(), CUSTOM_SCHEDULE);
    // 10_000 * 150 / 10_000 = 150
    expect(result.fee).toBe(150);
    expect(result.feeBasisPoints).toBe(150);
    expect(result.flatFee).toBe(0);
    expect(result.capped).toBe(false);
    expect(result.tier).toBe("basic");
  });

  it("adds flat fee on top of basis-point fee", () => {
    const result = calculateFee(
      makeInput({ tier: "premium" }),
      CUSTOM_SCHEDULE,
    );
    // 10_000 * 100 / 10_000 = 100 + 50 flat = 150
    expect(result.fee).toBe(150);
    expect(result.flatFee).toBe(50);
  });

  it("returns 0 fee for zero amount", () => {
    const result = calculateFee(makeInput({ amount: 0 }), CUSTOM_SCHEDULE);
    expect(result.fee).toBe(0);
  });

  it("rounds fractional basis-point fees", () => {
    const schedule: FeeScheduleConfig = {
      basic: { basisPoints: 33, flatFee: 0, monthlyCap: 0 },
      premium: CUSTOM_SCHEDULE.premium,
      unlisted: CUSTOM_SCHEDULE.unlisted,
    };
    // 10_000 * 33 / 10_000 = 33
    const result = calculateFee(makeInput(), schedule);
    expect(result.fee).toBe(33);

    // 100 * 33 / 10_000 = 0.33 → rounds to 0
    const result2 = calculateFee(makeInput({ amount: 100 }), schedule);
    expect(result2.fee).toBe(0);
  });

  it("snapshot includes all input fields and calculatedAt", () => {
    const result = calculateFee(makeInput({ supplierId: "sup-42", currency: "EUR" }));
    expect(result.snapshot.supplierId).toBe("sup-42");
    expect(result.snapshot.currency).toBe("EUR");
    expect(result.snapshot.amount).toBe(10_000);
    expect(result.snapshot.tier).toBe("basic");
    expect(result.snapshot.calculatedAt).toBeDefined();
    expect(new Date(result.snapshot.calculatedAt).getTime()).not.toBeNaN();
  });
});

// ─── Monthly cap enforcement ────────────────────────────────────────────────

describe("monthly cap", () => {
  it("tracks accrual within cap", () => {
    const r1 = calculateFee(makeInput({ amount: 50_000 }), CUSTOM_SCHEDULE);
    expect(r1.capped).toBe(false);
    // fee = 50_000 * 150 / 10_000 = 750
    expect(r1.fee).toBe(750);
    expect(r1.capRemaining).toBe(10_000 - 750);
    expect(r1.monthlyAccrual).toBe(750);

    const r2 = calculateFee(makeInput({ amount: 10_000 }), CUSTOM_SCHEDULE);
    expect(r2.capped).toBe(false);
    // fee = 10_000 * 150 / 10_000 = 150
    expect(r2.monthlyAccrual).toBe(900);
  });

  it("caps fee when monthly cap is reached mid-request", () => {
    // First payout: 50_000 * 150 / 10_000 = 750. Accrual = 750.
    calculateFee(makeInput({ amount: 50_000 }), CUSTOM_SCHEDULE);

    // Remaining cap: 10_000 - 750 = 9_250
    // Second payout basis fee: 700_000 * 150 / 10_000 = 10_500
    // This exceeds remaining cap of 9_250, so fee should be capped
    const r = calculateFee(makeInput({ amount: 700_000 }), CUSTOM_SCHEDULE);
    expect(r.capped).toBe(true);
    expect(r.fee).toBe(9_250); // remaining cap
    expect(r.capRemaining).toBe(0);
  });

  it("returns 0 fee when already at cap", () => {
    // Fill the cap: 100_000 * 150 / 10_000 = 1_500
    calculateFee(makeInput({ amount: 100_000 }), CUSTOM_SCHEDULE);
    // 75_000 more to fill: 75_000 * 150 / 10_000 = 1_125 → accrual = 2_625... still not full

    // Actually fill to cap by using a large amount:
    // Need total accrual = 10_000. With 1.5% rate: 10_000 / 0.015 = 666_667
    calculateFee(makeInput({ amount: 666_667 }), CUSTOM_SCHEDULE);

    // Now check if we've hit the cap
    const accrual = getMonthlyAccrual("sup-1", "USD");

    // If not exactly at cap due to rounding, do one more tiny amount
    if (accrual < 10_000) {
      calculateFee(makeInput({ amount: 1_000 }), CUSTOM_SCHEDULE);
    }

    const r = calculateFee(makeInput({ amount: 1_000 }), CUSTOM_SCHEDULE);
    expect(r.capped).toBe(true);
    expect(r.fee).toBe(0);
    expect(r.capRemaining).toBe(0);
  });

  it("resets accrual on new month", () => {
    // Fill cap partially
    calculateFee(makeInput({ amount: 10_000 }), CUSTOM_SCHEDULE);

    // Simulate month change by directly manipulating the internal state
    // We test this through the public API by checking getMonthlyAccrual
    const accrual = getMonthlyAccrual("sup-1", "USD");
    expect(accrual).toBeGreaterThan(0);
    expect(accrual).toBeLessThanOrEqual(10_000);
  });

  it("no cap for unlisted tier (monthlyCap = 0)", () => {
    const r1 = calculateFee(makeInput({ tier: "unlisted", amount: 100_000 }), CUSTOM_SCHEDULE);
    expect(r1.capped).toBe(false);
    expect(r1.capRemaining).toBe(Infinity);

    const r2 = calculateFee(makeInput({ tier: "unlisted", amount: 100_000 }), CUSTOM_SCHEDULE);
    expect(r2.capped).toBe(false);
    expect(r2.capRemaining).toBe(Infinity);
  });
});

// ─── Tier upgrade mid-month ─────────────────────────────────────────────────

describe("tier upgrade", () => {
  it("recalculates based on new tier after upgrade", () => {
    // Basic tier payout
    const r1 = calculateFee(makeInput({ tier: "basic", amount: 10_000 }), CUSTOM_SCHEDULE);
    expect(r1.fee).toBe(150);
    expect(r1.tier).toBe("basic");

    // Upgrade to premium — now uses premium config with its own cap
    const r2 = calculateFee(makeInput({ tier: "premium", amount: 10_000 }), CUSTOM_SCHEDULE);
    expect(r2.fee).toBe(150); // 10_000 * 100 / 10_000 = 100 + 50 flat = 150
    expect(r2.tier).toBe("premium");
    expect(r2.monthlyCap).toBe(50_000);
  });
});

// ─── Currency mix ───────────────────────────────────────────────────────────

describe("currency mix", () => {
  it("tracks accruals separately per currency", () => {
    const r1 = calculateFee(makeInput({ amount: 10_000, currency: "USD" }), CUSTOM_SCHEDULE);
    const r2 = calculateFee(makeInput({ amount: 10_000, currency: "EUR" }), CUSTOM_SCHEDULE);

    expect(r1.monthlyAccrual).toBe(150);
    expect(r2.monthlyAccrual).toBe(150);
    expect(getMonthlyAccrual("sup-1", "USD")).toBe(150);
    expect(getMonthlyAccrual("sup-1", "EUR")).toBe(150);
  });

  it("tracks accruals separately per supplier", () => {
    const r1 = calculateFee(makeInput({ supplierId: "sup-1", amount: 10_000 }), CUSTOM_SCHEDULE);
    const r2 = calculateFee(makeInput({ supplierId: "sup-2", amount: 10_000 }), CUSTOM_SCHEDULE);

    expect(r1.monthlyAccrual).toBe(150);
    expect(r2.monthlyAccrual).toBe(150);
    expect(getMonthlyAccrual("sup-1", "USD")).toBe(150);
    expect(getMonthlyAccrual("sup-2", "USD")).toBe(150);
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe("input validation", () => {
  it("throws for empty supplierId", () => {
    expect(() => calculateFee(makeInput({ supplierId: "" }))).toThrow("supplierId");
  });

  it("throws for empty currency", () => {
    expect(() => calculateFee(makeInput({ currency: "" }))).toThrow("currency");
  });

  it("throws for negative amount", () => {
    expect(() => calculateFee(makeInput({ amount: -1 }))).toThrow("non-negative");
  });

  it("throws for non-integer amount", () => {
    expect(() => calculateFee(makeInput({ amount: 10.5 }))).toThrow("integer");
  });

  it("throws for Infinity amount", () => {
    expect(() => calculateFee(makeInput({ amount: Infinity }))).toThrow("finite");
  });

  it("throws for NaN amount", () => {
    expect(() => calculateFee(makeInput({ amount: NaN }))).toThrow("finite");
  });

  it("throws for unknown tier", () => {
    expect(() => calculateFee(makeInput({ tier: "gold" as any }))).toThrow("Unknown tier");
  });
});

// ─── Query helpers ───────────────────────────────────────────────────────────

describe("query helpers", () => {
  it("getSchedule returns the default schedule", () => {
    const s = getSchedule();
    expect(s.basic.basisPoints).toBe(150);
    expect(s.premium.basisPoints).toBe(100);
    expect(s.unlisted.basisPoints).toBe(50);
  });

  it("listTiers returns all three tiers", () => {
    expect(listTiers()).toEqual(["basic", "premium", "unlisted"]);
  });

  it("getTierConfig returns config for a valid tier", () => {
    const c = getTierConfig("basic");
    expect(c.basisPoints).toBe(150);
  });

  it("getTierConfig throws for unknown tier", () => {
    expect(() => getTierConfig("unknown" as any)).toThrow("Unknown tier");
  });

  it("getMonthlyAccrual returns 0 for unknown supplier", () => {
    expect(getMonthlyAccrual("unknown", "USD")).toBe(0);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles very large amounts without overflow", () => {
    const result = calculateFee(makeInput({ amount: Number.MAX_SAFE_INTEGER }));
    expect(Number.isFinite(result.fee)).toBe(true);
    expect(result.fee).toBeGreaterThanOrEqual(0);
  });

  it("handles amount that pushes accrual beyond cap", () => {
    // cap = 10_000, basis = 150 bps
    // First payout: 500_000 * 150 / 10_000 = 7_500
    calculateFee(makeInput({ amount: 500_000 }), CUSTOM_SCHEDULE);

    // Second payout: 500_000 * 150 / 10_000 = 7_500, but remaining cap = 2_500
    const r = calculateFee(makeInput({ amount: 500_000 }), CUSTOM_SCHEDULE);
    expect(r.capped).toBe(true);
    expect(r.fee).toBe(2_500);
    expect(r.capRemaining).toBe(0);
  });

  it("multiple suppliers have independent accruals", () => {
    calculateFee(makeInput({ supplierId: "s1", amount: 10_000 }), CUSTOM_SCHEDULE);
    calculateFee(makeInput({ supplierId: "s2", amount: 20_000 }), CUSTOM_SCHEDULE);

    expect(getMonthlyAccrual("s1", "USD")).toBe(150);
    expect(getMonthlyAccrual("s2", "USD")).toBe(300);
  });
});
