import { PartialRefundCalculator } from "../partialRefundCalculator.js";

describe("PartialRefundCalculator", () => {
  it("should calculate refund with fixed rules only", () => {
    const result = PartialRefundCalculator.calculate(1000, [{ type: "fixed", value: 200 }], "USD");
    expect(result).toBe(800);
  });

  it("should calculate refund with percent rules only", () => {
    const result = PartialRefundCalculator.calculate(1000, [{ type: "percent", value: 20 }], "USD");
    expect(result).toBe(800); // 1000 - 20%
  });

  it("should apply fixed precedence before percent", () => {
    // 1000 - 200 (fixed) = 800. Then 800 - 10% (percent) = 720.
    const result = PartialRefundCalculator.calculate(
      1000,
      [
        { type: "percent", value: 10 },
        { type: "fixed", value: 200 }
      ],
      "USD"
    );
    expect(result).toBe(720);
  });

  it("should not drop below zero", () => {
    const result = PartialRefundCalculator.calculate(100, [{ type: "fixed", value: 200 }], "USD");
    expect(result).toBe(0);
  });

  describe("Rounding Policy", () => {
    it("should round half-to-even for USD (banker's rounding)", () => {
      // 2.5 rounds to 2
      let result = PartialRefundCalculator.calculate(10, [{ type: "percent", value: 75 }], "USD");
      expect(result).toBe(2); // 10 - 75% = 2.5 -> rounds to even (2)

      // 3.5 rounds to 4
      result = PartialRefundCalculator.calculate(14, [{ type: "percent", value: 75 }], "USD");
      expect(result).toBe(4); // 14 - 75% = 3.5 -> rounds to even (4)
    });

    it("should truncate for XLM", () => {
      // 3.8 should truncate to 3
      const result = PartialRefundCalculator.calculate(10, [{ type: "percent", value: 62 }], "XLM");
      expect(result).toBe(3); // 10 - 62% = 3.8 -> truncates to 3
    });
  });

  describe("Edge cases and validation", () => {
    it("should throw error if percent > 100", () => {
      expect(() => {
        PartialRefundCalculator.calculate(1000, [{ type: "percent", value: 105 }], "USD");
      }).toThrow("Percent rule value must be between 0 and 100");
    });

    it("should throw error if percent < 0", () => {
      expect(() => {
        PartialRefundCalculator.calculate(1000, [{ type: "percent", value: -10 }], "USD");
      }).toThrow("Percent rule value must be between 0 and 100");
    });

    it("should throw error if fixed is negative", () => {
      expect(() => {
        PartialRefundCalculator.calculate(1000, [{ type: "fixed", value: -50 }], "USD");
      }).toThrow("Fixed rule value must be a non-negative integer");
    });

    it("should throw error if fixed is not integer", () => {
      expect(() => {
        PartialRefundCalculator.calculate(1000, [{ type: "fixed", value: 50.5 }], "USD");
      }).toThrow("Fixed rule value must be a non-negative integer");
    });

    it("should throw error if original amount is negative", () => {
      expect(() => {
        PartialRefundCalculator.calculate(-1000, [], "USD");
      }).toThrow("originalAmount must be a non-negative integer");
    });
  });
});
