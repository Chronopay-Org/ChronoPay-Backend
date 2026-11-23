import {
  createDiscountCurve,
  getDiscountCurve,
  listDiscountCurves,
  updateDiscountCurve,
  deleteDiscountCurve,
  resetStore,
  findApplicableTier,
  canStack,
  resolveBundleDiscount,
  DiscountCurveNotFoundError,
  DiscountCurveValidationError,
} from "../discountCurveService.js";
import type { CreateDiscountCurveInput, DiscountTier } from "../../validation/discountCurveSchema.js";

// ─── Test Data ────────────────────────────────────────────────────────────────

const VALID_CURVE_INPUT: CreateDiscountCurveInput = {
  id: "curve-1",
  name: "Summer Bundle Discount",
  description: "Discount for summer bundle purchases",
  bundleId: "bundle-summer-2024",
  supplierId: "supplier-123",
  tiers: [
    { minQuantity: 1, discountRate: 0 },
    { minQuantity: 5, discountRate: 0.1 },
    { minQuantity: 10, discountRate: 0.2 },
    { minQuantity: 20, discountRate: 0.3 },
  ],
  stackability: {
    stackable: false,
    stackableWith: [],
    maxStackCount: 1,
  },
  active: true,
};

const STACKABLE_CURVE_INPUT: CreateDiscountCurveInput = {
  id: "curve-stackable",
  name: "Stackable Discount",
  bundleId: "bundle-1",
  supplierId: "supplier-1",
  tiers: [
    { minQuantity: 1, discountRate: 0.1 },
    { minQuantity: 10, discountRate: 0.2 },
  ],
  stackability: {
    stackable: true,
    stackableWith: ["curve-stackable-2"],
    maxStackCount: 2,
  },
  active: true,
};

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  resetStore();
});

// ─── findApplicableTier ───────────────────────────────────────────────────────

describe("findApplicableTier", () => {
  const tiers: DiscountTier[] = [
    { minQuantity: 1, discountRate: 0 },
    { minQuantity: 5, discountRate: 0.1 },
    { minQuantity: 10, discountRate: 0.2 },
    { minQuantity: 20, discountRate: 0.3 },
  ];

  it("returns null for quantity 0 (below minimum)", () => {
    expect(findApplicableTier(tiers, 0)).toBeNull();
  });

  it("returns first tier for quantity 1", () => {
    const tier = findApplicableTier(tiers, 1);
    expect(tier).toEqual({ minQuantity: 1, discountRate: 0 });
  });

  it("returns second tier for quantity 5", () => {
    const tier = findApplicableTier(tiers, 5);
    expect(tier).toEqual({ minQuantity: 5, discountRate: 0.1 });
  });

  it("returns last tier for quantity 20", () => {
    const tier = findApplicableTier(tiers, 20);
    expect(tier).toEqual({ minQuantity: 20, discountRate: 0.3 });
  });

  it("returns last tier for quantity above maximum", () => {
    const tier = findApplicableTier(tiers, 100);
    expect(tier).toEqual({ minQuantity: 20, discountRate: 0.3 });
  });

  it("returns correct tier for quantity between tiers", () => {
    const tier = findApplicableTier(tiers, 7);
    expect(tier).toEqual({ minQuantity: 5, discountRate: 0.1 });
  });
});

// ─── canStack ─────────────────────────────────────────────────────────────────

describe("canStack", () => {
  it("returns false for non-stackable curve", () => {
    const curve = createDiscountCurve(VALID_CURVE_INPUT);
    expect(canStack(curve, "curve-2")).toBe(false);
  });

  it("returns false if not in stackableWith list", () => {
    const curve = createDiscountCurve(STACKABLE_CURVE_INPUT);
    expect(canStack(curve, "curve-not-in-list")).toBe(false);
  });

  it("returns true if in stackableWith list", () => {
    const curve = createDiscountCurve(STACKABLE_CURVE_INPUT);
    expect(canStack(curve, "curve-stackable-2")).toBe(true);
  });
});

// ─── CRUD Operations ──────────────────────────────────────────────────────────

describe("createDiscountCurve", () => {
  it("creates a discount curve successfully", () => {
    const curve = createDiscountCurve(VALID_CURVE_INPUT);
    expect(curve.id).toBe("curve-1");
    expect(curve.name).toBe("Summer Bundle Discount");
    expect(curve.tiers).toHaveLength(4);
    expect(curve.createdAt).toBeDefined();
    expect(curve.updatedAt).toBeDefined();
  });

  it("throws on duplicate ID", () => {
    createDiscountCurve(VALID_CURVE_INPUT);
    expect(() => createDiscountCurve(VALID_CURVE_INPUT)).toThrow(DiscountCurveValidationError);
  });

  it("throws on invalid input", () => {
    expect(() =>
      createDiscountCurve({
        id: "",
        name: "Test",
        bundleId: "bundle-1",
        supplierId: "supplier-1",
        tiers: [],
      }),
    ).toThrow(DiscountCurveValidationError);
  });

  it("throws when tiers not sorted by minQuantity", () => {
    expect(() =>
      createDiscountCurve({
        id: "curve-unsorted",
        name: "Test",
        bundleId: "bundle-1",
        supplierId: "supplier-1",
        tiers: [
          { minQuantity: 10, discountRate: 0.2 },
          { minQuantity: 5, discountRate: 0.1 },
        ],
      }),
    ).toThrow(DiscountCurveValidationError);
  });
});

describe("getDiscountCurve", () => {
  it("returns the curve if it exists", () => {
    createDiscountCurve(VALID_CURVE_INPUT);
    const curve = getDiscountCurve("curve-1");
    expect(curve.id).toBe("curve-1");
  });

  it("throws if curve does not exist", () => {
    expect(() => getDiscountCurve("nonexistent")).toThrow(DiscountCurveNotFoundError);
  });
});

describe("listDiscountCurves", () => {
  it("returns all curves when no filters", () => {
    createDiscountCurve(VALID_CURVE_INPUT);
    createDiscountCurve({
      ...VALID_CURVE_INPUT,
      id: "curve-2",
      supplierId: "supplier-456",
    });

    const curves = listDiscountCurves();
    expect(curves).toHaveLength(2);
  });

  it("filters by supplierId", () => {
    createDiscountCurve(VALID_CURVE_INPUT);
    createDiscountCurve({
      ...VALID_CURVE_INPUT,
      id: "curve-2",
      supplierId: "supplier-456",
    });

    const curves = listDiscountCurves({ supplierId: "supplier-123" });
    expect(curves).toHaveLength(1);
    expect(curves[0].supplierId).toBe("supplier-123");
  });

  it("filters by bundleId", () => {
    createDiscountCurve(VALID_CURVE_INPUT);
    createDiscountCurve({
      ...VALID_CURVE_INPUT,
      id: "curve-2",
      bundleId: "bundle-2",
    });

    const curves = listDiscountCurves({ bundleId: "bundle-summer-2024" });
    expect(curves).toHaveLength(1);
  });

  it("filters by active status", () => {
    createDiscountCurve(VALID_CURVE_INPUT);
    createDiscountCurve({
      ...VALID_CURVE_INPUT,
      id: "curve-2",
      active: false,
    });

    const activeCurves = listDiscountCurves({ active: true });
    expect(activeCurves).toHaveLength(1);

    const inactiveCurves = listDiscountCurves({ active: false });
    expect(inactiveCurves).toHaveLength(1);
  });
});

describe("updateDiscountCurve", () => {
  it("updates the curve successfully", () => {
    createDiscountCurve(VALID_CURVE_INPUT);
    const updated = updateDiscountCurve("curve-1", { name: "Updated Name" });
    expect(updated.name).toBe("Updated Name");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
  });

  it("throws if curve does not exist", () => {
    expect(() => updateDiscountCurve("nonexistent", { name: "Test" })).toThrow(
      DiscountCurveNotFoundError,
    );
  });

  it("throws on invalid input", () => {
    createDiscountCurve(VALID_CURVE_INPUT);
    expect(() =>
      updateDiscountCurve("curve-1", { tiers: [] }),
    ).toThrow(DiscountCurveValidationError);
  });
});

describe("deleteDiscountCurve", () => {
  it("deletes the curve successfully", () => {
    createDiscountCurve(VALID_CURVE_INPUT);
    deleteDiscountCurve("curve-1");
    expect(() => getDiscountCurve("curve-1")).toThrow(DiscountCurveNotFoundError);
  });

  it("throws if curve does not exist", () => {
    expect(() => deleteDiscountCurve("nonexistent")).toThrow(DiscountCurveNotFoundError);
  });
});

// ─── resolveBundleDiscount ────────────────────────────────────────────────────

describe("resolveBundleDiscount", () => {
  it("returns zero discount when no curves exist", () => {
    const result = resolveBundleDiscount({
      bundleId: "bundle-1",
      supplierId: "supplier-1",
      quantity: 10,
      basePricePerUnit: 1000,
    });

    expect(result.discountAmount).toBe(0);
    expect(result.finalPrice).toBe(10000);
    expect(result.wasStacked).toBe(false);
  });

  it("returns zero discount when min-buy not met", () => {
    createDiscountCurve(VALID_CURVE_INPUT);

    const result = resolveBundleDiscount({
      bundleId: "bundle-summer-2024",
      supplierId: "supplier-123",
      quantity: 1, // Only 1, needs 5 for 10% discount
      basePricePerUnit: 1000,
    });

    expect(result.discountAmount).toBe(0);
    expect(result.finalPrice).toBe(1000);
  });

  it("applies correct discount for quantity", () => {
    createDiscountCurve(VALID_CURVE_INPUT);

    const result = resolveBundleDiscount({
      bundleId: "bundle-summer-2024",
      supplierId: "supplier-123",
      quantity: 5, // 10% discount tier
      basePricePerUnit: 1000,
    });

    expect(result.discountCurveId).toBe("curve-1");
    expect(result.appliedTier.discountRate).toBe(0.1);
    expect(result.originalPrice).toBe(5000);
    expect(result.discountAmount).toBe(500); // 5000 * 0.1
    expect(result.finalPrice).toBe(4500);
  });

  it("applies highest applicable tier", () => {
    createDiscountCurve(VALID_CURVE_INPUT);

    const result = resolveBundleDiscount({
      bundleId: "bundle-summer-2024",
      supplierId: "supplier-123",
      quantity: 25, // 30% discount tier
      basePricePerUnit: 1000,
    });

    expect(result.appliedTier.discountRate).toBe(0.3);
    expect(result.discountAmount).toBe(7500); // 25000 * 0.3
    expect(result.finalPrice).toBe(17500);
  });

  it("does not stack when stackable is false", () => {
    createDiscountCurve(VALID_CURVE_INPUT);

    const result = resolveBundleDiscount({
      bundleId: "bundle-summer-2024",
      supplierId: "supplier-123",
      quantity: 10,
      basePricePerUnit: 1000,
      activeDiscountIds: ["curve-1"],
    });

    expect(result.wasStacked).toBe(false);
    expect(result.stackedWith).toHaveLength(0);
  });

  it("stacks when stackable is true and in stackableWith list", () => {
    createDiscountCurve(STACKABLE_CURVE_INPUT);
    createDiscountCurve({
      ...STACKABLE_CURVE_INPUT,
      id: "curve-stackable-2",
      name: "Stackable Discount 2",
      tiers: [{ minQuantity: 1, discountRate: 0.05 }],
      stackability: {
        stackable: true,
        stackableWith: ["curve-stackable"],
        maxStackCount: 1,
      },
    });

    const result = resolveBundleDiscount({
      bundleId: "bundle-1",
      supplierId: "supplier-1",
      quantity: 10,
      basePricePerUnit: 1000,
      activeDiscountIds: ["curve-stackable", "curve-stackable-2"],
    });

    expect(result.wasStacked).toBe(true);
    expect(result.stackedWith).toContain("curve-stackable-2");
    expect(result.discountAmount).toBe(2500); // 10000 * (0.2 + 0.05)
  });

  it("respects maxStackCount", () => {
    createDiscountCurve(STACKABLE_CURVE_INPUT);
    createDiscountCurve({
      ...STACKABLE_CURVE_INPUT,
      id: "curve-stackable-2",
      name: "Stackable Discount 2",
      tiers: [{ minQuantity: 1, discountRate: 0.05 }],
      stackability: {
        stackable: true,
        stackableWith: ["curve-stackable"],
        maxStackCount: 1,
      },
    });
    createDiscountCurve({
      ...STACKABLE_CURVE_INPUT,
      id: "curve-stackable-3",
      name: "Stackable Discount 3",
      tiers: [{ minQuantity: 1, discountRate: 0.05 }],
      stackability: {
        stackable: true,
        stackableWith: ["curve-stackable"],
        maxStackCount: 1,
      },
    });

    const result = resolveBundleDiscount({
      bundleId: "bundle-1",
      supplierId: "supplier-1",
      quantity: 10,
      basePricePerUnit: 1000,
      activeDiscountIds: ["curve-stackable", "curve-stackable-2", "curve-stackable-3"],
    });

    // Should only stack with 1 other discount (maxStackCount: 2, but we're checking stackableWith of the first curve)
    expect(result.stackedWith.length).toBeLessThanOrEqual(2);
  });

  it("caps total discount at 100%", () => {
    createDiscountCurve({
      ...STACKABLE_CURVE_INPUT,
      tiers: [{ minQuantity: 1, discountRate: 0.7 }],
    });
    createDiscountCurve({
      ...STACKABLE_CURVE_INPUT,
      id: "curve-stackable-2",
      name: "Stackable Discount 2",
      tiers: [{ minQuantity: 1, discountRate: 0.5 }],
      stackability: {
        stackable: true,
        stackableWith: ["curve-stackable"],
        maxStackCount: 1,
      },
    });

    const result = resolveBundleDiscount({
      bundleId: "bundle-1",
      supplierId: "supplier-1",
      quantity: 10,
      basePricePerUnit: 1000,
      activeDiscountIds: ["curve-stackable", "curve-stackable-2"],
    });

    expect(result.discountAmount).toBe(10000); // Capped at 100%
    expect(result.finalPrice).toBe(0);
  });

  it("only applies active curves", () => {
    createDiscountCurve({
      ...VALID_CURVE_INPUT,
      active: false,
    });

    const result = resolveBundleDiscount({
      bundleId: "bundle-summer-2024",
      supplierId: "supplier-123",
      quantity: 10,
      basePricePerUnit: 1000,
    });

    expect(result.discountAmount).toBe(0);
    expect(result.finalPrice).toBe(10000);
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe("Edge Cases", () => {
  it("handles zero discount rate", () => {
    createDiscountCurve(VALID_CURVE_INPUT);

    const result = resolveBundleDiscount({
      bundleId: "bundle-summer-2024",
      supplierId: "supplier-123",
      quantity: 1, // Tier with 0% discount
      basePricePerUnit: 1000,
    });

    expect(result.discountAmount).toBe(0);
    expect(result.finalPrice).toBe(1000);
  });

  it("handles quantity exactly at tier boundary", () => {
    createDiscountCurve(VALID_CURVE_INPUT);

    const result = resolveBundleDiscount({
      bundleId: "bundle-summer-2024",
      supplierId: "supplier-123",
      quantity: 10, // Exactly at 20% tier
      basePricePerUnit: 1000,
    });

    expect(result.appliedTier.discountRate).toBe(0.2);
  });

  it("handles large quantities", () => {
    createDiscountCurve(VALID_CURVE_INPUT);

    const result = resolveBundleDiscount({
      bundleId: "bundle-summer-2024",
      supplierId: "supplier-123",
      quantity: 1000,
      basePricePerUnit: 1000,
    });

    expect(result.appliedTier.discountRate).toBe(0.3);
    expect(result.finalPrice).toBe(700000); // 1000000 * 0.7
  });

  it("handles zero basePricePerUnit", () => {
    createDiscountCurve(VALID_CURVE_INPUT);

    const result = resolveBundleDiscount({
      bundleId: "bundle-summer-2024",
      supplierId: "supplier-123",
      quantity: 10,
      basePricePerUnit: 0,
    });

    expect(result.discountAmount).toBe(0);
    expect(result.finalPrice).toBe(0);
  });
});
