import { AmountUtils, MAX_MINOR_AMOUNT } from "../utils/amount.js";

describe("AmountUtils", () => {
  describe("validate", () => {
    it("should accept valid minor positive integers", () => {
      expect(AmountUtils.validate(1)).toBe(true);
      expect(AmountUtils.validate(1050)).toBe(true);
      expect(AmountUtils.validate(MAX_MINOR_AMOUNT)).toBe(true);
    });

    it("should reject raw floats implicitly", () => {
      expect(AmountUtils.validate(10.5)).toBe(false);
      expect(AmountUtils.validate(0.0001)).toBe(false);
      expect(AmountUtils.validate(1.00000000000001)).toBe(false);
    });

    it("should reject negative values and zero", () => {
      expect(AmountUtils.validate(0)).toBe(false);
      expect(AmountUtils.validate(-1)).toBe(false);
      expect(AmountUtils.validate(-1050)).toBe(false);
    });

    it("should reject amounts exceeding maximum limit", () => {
      expect(AmountUtils.validate(MAX_MINOR_AMOUNT + 1)).toBe(false);
      expect(AmountUtils.validate(Infinity)).toBe(false);
    });

    it("should reject strings and other data types", () => {
      expect(AmountUtils.validate("1050")).toBe(false);
      expect(AmountUtils.validate("10.50")).toBe(false);
      expect(AmountUtils.validate(null)).toBe(false);
      expect(AmountUtils.validate(undefined)).toBe(false);
      expect(AmountUtils.validate({})).toBe(false);
    });
  });

  describe("add", () => {
    it("should add two valid bounds successfully", () => {
      expect(AmountUtils.add(100, 200)).toBe(300);
      expect(AmountUtils.add(1050, 1050)).toBe(2100);
    });

    it("should reject addition generating bound over flow", () => {
      expect(() => AmountUtils.add(MAX_MINOR_AMOUNT, 1)).toThrow("safe integer boundaries");
    });

    it("should reject invalid params during addition", () => {
      expect(() => AmountUtils.add(10.5, 100)).toThrow("Invalid base amount");
      expect(() => AmountUtils.add(100, -50)).toThrow("Invalid addend amount");
      // @ts-ignore
      expect(() => AmountUtils.add("100", 200)).toThrow("Invalid base amount");
    });
  });

  describe("calculateFee", () => {
    it("should calculate exact bps boundaries correctly", () => {
      // 10000 cents ($100), 100 bps (1%)
      expect(AmountUtils.calculateFee(10000, 100)).toBe(100); 
    });

    it("should use half-up rounding on floating fractions deterministically", () => {
      // 1050 cents ($10.50), 150 bps (1.5%) -> 15.75 cents
      // 15.75 cents -> half up round -> 16 cents
      expect(AmountUtils.calculateFee(1050, 150)).toBe(16);
      
      // 1050 cents ($10.50), 125 bps (1.25%) -> 13.125 cents
      // 13.125 cents -> rounds down -> 13 cents
      expect(AmountUtils.calculateFee(1050, 125)).toBe(13);
    });

    it("should throw on invalid format or boundaries", () => {
      expect(() => AmountUtils.calculateFee(10.5, 100)).toThrow("Invalid amount for fee calculation");
      expect(() => AmountUtils.calculateFee(1000, -100)).toThrow("BPS must be integer between 0 and 10000");
      expect(() => AmountUtils.calculateFee(1000, 10001)).toThrow("BPS must be integer between 0 and 10000");
      expect(() => AmountUtils.calculateFee(1000, 15.5)).toThrow("BPS must be integer");
    });
  });

  describe("parseFromMajorString", () => {
    it("should parse standard fixed decimal amounts to integer seamlessly", () => {
      expect(AmountUtils.parseFromMajorString("10.50", "USD")).toBe(1050);
      expect(AmountUtils.parseFromMajorString("10", "USD")).toBe(1000);
      expect(AmountUtils.parseFromMajorString("0.99", "USD")).toBe(99);
      expect(AmountUtils.parseFromMajorString("1.0000000", "XLM")).toBe(10000000);
      expect(AmountUtils.parseFromMajorString("1.5", "XLM")).toBe(15000000);
    });

    it("should reject invalid decimal limits to avoid bypasses", () => {
      expect(() => AmountUtils.parseFromMajorString("10.501", "USD")).toThrow("format string to parse");
      expect(() => AmountUtils.parseFromMajorString("10.50.10", "USD")).toThrow("format string to parse");
      expect(() => AmountUtils.parseFromMajorString("abc", "USD")).toThrow("format string to parse");
    });

    it("should reject parsing that exceeds absolute bounds or yields 0", () => {
      expect(() => AmountUtils.parseFromMajorString("0.00", "USD")).toThrow("failed integer validation safely");
      expect(() => AmountUtils.parseFromMajorString("1000000000000000.00", "USD")).toThrow("failed integer validation safely");
    });
    
    it("should throw on unsupported currency", () => {
      // @ts-ignore
      expect(() => AmountUtils.parseFromMajorString("10.50", "BTC")).toThrow("Unsupported currency format");
    });
  });

  describe("formatToMajorString", () => {
    it("should execute pure conversion downwards seamlessly", () => {
      expect(AmountUtils.formatToMajorString(1050, "USD")).toBe("10.50");
      expect(AmountUtils.formatToMajorString(1000, "USD")).toBe("10.00");
      expect(AmountUtils.formatToMajorString(99, "USD")).toBe("0.99");
      expect(AmountUtils.formatToMajorString(1, "USD")).toBe("0.01");
      expect(AmountUtils.formatToMajorString(10000000, "XLM")).toBe("1.0000000");
      expect(AmountUtils.formatToMajorString(5, "XLM")).toBe("0.0000005");
    });

    it("should reject invalid baseline formats locally", () => {
      expect(() => AmountUtils.formatToMajorString(10.5, "USD")).toThrow("Invalid amount for formatting");
      expect(() => AmountUtils.formatToMajorString(-1050, "USD")).toThrow("Invalid amount for formatting");
    });

    it("should throw on unsupported currency formatting attempts", () => {
      // @ts-ignore
      expect(() => AmountUtils.formatToMajorString(1050, "BTC")).toThrow("Unsupported currency format");
    });
  });
});
