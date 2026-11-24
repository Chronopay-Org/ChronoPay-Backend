import {
  canStack,
  createDiscountCurve,
  deleteDiscountCurve,
  DiscountCurveNotFoundError,
  DiscountCurveValidationError,
  findApplicableTier,
  getDiscountCurve,
  listDiscountCurves,
  resetStore,
  resolveBundleDiscount,
  updateDiscountCurve,
} from "../discountCurveService.js";
import type { CreateDiscountCurveRawInput, DiscountTier } from "../../validation/discountCurveSchema.js";

const curveInput: CreateDiscountCurveRawInput = {
  id: "curve-1",
  name: "Summer Bundle Discount",
  bundleId: "bundle-1",
  supplierId: "supplier-1",
  tiers: [
    { minQuantity: 1, discountRate: 0 },
    { minQuantity: 5, discountRate: 0.1 },
    { minQuantity: 10, discountRate: 0.2 },
  ],
};

beforeEach(() => {
  resetStore();
});

describe("findApplicableTier", () => {
  const tiers: DiscountTier[] = [
    { minQuantity: 1, discountRate: 0 },
    { minQuantity: 5, discountRate: 0.1 },
    { minQuantity: 10, discountRate: 0.2 },
  ];

  it("returns the highest tier met, or null below the minimum", () => {
    expect(findApplicableTier(tiers, 0)).toBeNull();
    expect(findApplicableTier(tiers, 7)).toEqual(tiers[1]);
    expect(findApplicableTier(tiers, 20)).toEqual(tiers[2]);
  });
});

describe("discount curve repository-backed service", () => {
  it("creates and retrieves normalized records with their timestamps", async () => {
    const created = await createDiscountCurve(curveInput);
    const retrieved = await getDiscountCurve(curveInput.id);

    expect(created.stackability).toEqual({
      stackable: false,
      stackableWith: [],
      maxStackCount: 1,
    });
    expect(retrieved).toEqual(created);
    expect(created.updatedAt).toBe(created.createdAt);
  });

  it("rejects duplicate IDs and invalid curve data", async () => {
    await createDiscountCurve(curveInput);
    await expect(createDiscountCurve(curveInput)).rejects.toThrow(
      DiscountCurveValidationError,
    );
    await expect(
      createDiscountCurve({ ...curveInput, tiers: [] }),
    ).rejects.toThrow(DiscountCurveValidationError);
  });

  it("lists curves using all supported filters", async () => {
    await createDiscountCurve(curveInput);
    await createDiscountCurve({
      ...curveInput,
      id: "curve-2",
      supplierId: "supplier-2",
      active: false,
    });

    await expect(
      listDiscountCurves({ supplierId: "supplier-1", active: true }),
    ).resolves.toHaveLength(1);
    await expect(listDiscountCurves({ bundleId: "other-bundle" })).resolves.toEqual(
      [],
    );
  });

  it("updates validated fields while preserving identity and creation time", async () => {
    const original = await createDiscountCurve(curveInput);
    await updateDiscountCurve(curveInput.id, { validUntil: 100 });
    const updated = await updateDiscountCurve(curveInput.id, {
      name: "Updated",
    });

    expect(updated.name).toBe("Updated");
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
    await expect(
      updateDiscountCurve(curveInput.id, { tiers: [] }),
    ).rejects.toThrow(DiscountCurveValidationError);
    await expect(
      updateDiscountCurve(curveInput.id, { validFrom: 200 }),
    ).rejects.toThrow(DiscountCurveValidationError);
  });

  it("throws not-found errors for missing records and deletes existing records", async () => {
    await expect(getDiscountCurve("missing")).rejects.toThrow(
      DiscountCurveNotFoundError,
    );
    await expect(
      updateDiscountCurve("missing", { name: "Updated" }),
    ).rejects.toThrow(DiscountCurveNotFoundError);
    await expect(deleteDiscountCurve("missing")).rejects.toThrow(
      DiscountCurveNotFoundError,
    );

    await createDiscountCurve(curveInput);
    await deleteDiscountCurve(curveInput.id);
    await expect(getDiscountCurve(curveInput.id)).rejects.toThrow(
      DiscountCurveNotFoundError,
    );
  });

  it("resolves stackable discounts through the injected in-memory repository", async () => {
    const curve = await createDiscountCurve({
      ...curveInput,
      stackability: {
        stackable: true,
        stackableWith: ["curve-2"],
        maxStackCount: 1,
      },
    });
    await createDiscountCurve({
      ...curveInput,
      id: "curve-2",
      tiers: [{ minQuantity: 1, discountRate: 0.05 }],
      stackability: {
        stackable: true,
        stackableWith: [curve.id],
        maxStackCount: 1,
      },
    });

    expect(canStack(curve, "curve-2")).toBe(true);
    await expect(
      resolveBundleDiscount({
        bundleId: curveInput.bundleId,
        supplierId: curveInput.supplierId,
        quantity: 10,
        basePricePerUnit: 1000,
        activeDiscountIds: [curve.id, "curve-2"],
      }),
    ).resolves.toMatchObject({
      discountCurveId: curve.id,
      discountAmount: 2500,
      finalPrice: 7500,
      wasStacked: true,
      stackedWith: ["curve-2"],
    });
  });
});
