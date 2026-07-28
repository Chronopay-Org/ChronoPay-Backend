import { CreateDiscountCurveSchema, UpdateDiscountCurveSchema } from "../discountCurveSchema.js";

describe("CreateDiscountCurveSchema", () => {
  const validInput = {
    id: "curve-1",
    name: "Test Discount",
    bundleId: "bundle-1",
    supplierId: "supplier-1",
    tiers: [
      { minQuantity: 1, discountRate: 0 },
      { minQuantity: 5, discountRate: 0.1 },
    ],
  };

  it("validates correct input", () => {
    const result = CreateDiscountCurveSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("adds default values", () => {
    const result = CreateDiscountCurveSchema.parse(validInput);
    expect(result.active).toBe(true);
    expect(result.stackability.stackable).toBe(false);
    expect(result.stackability.stackableWith).toEqual([]);
    expect(result.stackability.maxStackCount).toBe(1);
  });

  it("rejects empty id", () => {
    const result = CreateDiscountCurveSchema.safeParse({ ...validInput, id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = CreateDiscountCurveSchema.safeParse({ ...validInput, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty tiers", () => {
    const result = CreateDiscountCurveSchema.safeParse({ ...validInput, tiers: [] });
    expect(result.success).toBe(false);
  });

  it("rejects discountRate < 0", () => {
    const result = CreateDiscountCurveSchema.safeParse({
      ...validInput,
      tiers: [{ minQuantity: 1, discountRate: -0.1 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects discountRate > 1", () => {
    const result = CreateDiscountCurveSchema.safeParse({
      ...validInput,
      tiers: [{ minQuantity: 1, discountRate: 1.1 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects minQuantity < 1", () => {
    const result = CreateDiscountCurveSchema.safeParse({
      ...validInput,
      tiers: [{ minQuantity: 0, discountRate: 0.1 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsorted tiers", () => {
    const result = CreateDiscountCurveSchema.safeParse({
      ...validInput,
      tiers: [
        { minQuantity: 10, discountRate: 0.2 },
        { minQuantity: 5, discountRate: 0.1 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects validFrom >= validUntil", () => {
    const result = CreateDiscountCurveSchema.safeParse({
      ...validInput,
      validFrom: 2000,
      validUntil: 1000,
    });
    expect(result.success).toBe(false);
  });

  it("accepts validFrom < validUntil", () => {
    const result = CreateDiscountCurveSchema.safeParse({
      ...validInput,
      validFrom: 1000,
      validUntil: 2000,
    });
    expect(result.success).toBe(true);
  });
});

describe("UpdateDiscountCurveSchema", () => {
  it("allows partial updates", () => {
    const result = UpdateDiscountCurveSchema.safeParse({ name: "Updated Name" });
    expect(result.success).toBe(true);
  });

  it("strips id field", () => {
    const result = UpdateDiscountCurveSchema.safeParse({ id: "new-id", name: "Test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("id");
    }
  });

  it("validates tier constraints on update", () => {
    const result = UpdateDiscountCurveSchema.safeParse({
      tiers: [{ minQuantity: 1, discountRate: 1.5 }],
    });
    expect(result.success).toBe(false);
  });
});
