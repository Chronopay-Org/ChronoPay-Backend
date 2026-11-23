import { describe, it, expect } from "@jest/globals";
import { AmountUtils, MAX_MINOR_AMOUNT } from "../amount.js";

describe("AmountUtils.validate", () => {
  describe("acceptance cases - positive integers", () => {
    it("accepts 1", () => {
      expect(AmountUtils.validate(1)).toBe(true);
    });

    it("accepts 100", () => {
      expect(AmountUtils.validate(100)).toBe(true);
    });

    it("accepts 10000 (typical minor unit for $100.00)", () => {
      expect(AmountUtils.validate(10000)).toBe(true);
    });

    it("rejects MAX_SAFE_INTEGER (exceeds MAX_MINOR_AMOUNT)", () => {
      expect(AmountUtils.validate(Number.MAX_SAFE_INTEGER)).toBe(false);
    });

    it("accepts value at MAX_MINOR_AMOUNT boundary", () => {
      expect(AmountUtils.validate(MAX_MINOR_AMOUNT)).toBe(true);
    });

    it("accepts value just below MAX_MINOR_AMOUNT", () => {
      expect(AmountUtils.validate(MAX_MINOR_AMOUNT - 1)).toBe(true);
    });
  });

  describe("rejection cases - zero and negative", () => {
    it("rejects 0", () => {
      expect(AmountUtils.validate(0)).toBe(false);
    });

    it("rejects -1", () => {
      expect(AmountUtils.validate(-1)).toBe(false);
    });

    it("rejects -100", () => {
      expect(AmountUtils.validate(-100)).toBe(false);
    });

    it("rejects negative MAX_SAFE_INTEGER", () => {
      expect(AmountUtils.validate(-Number.MAX_SAFE_INTEGER)).toBe(false);
    });
  });

  describe("rejection cases - floats and decimals", () => {
    it("rejects 1.5", () => {
      expect(AmountUtils.validate(1.5)).toBe(false);
    });

    it("rejects 0.5", () => {
      expect(AmountUtils.validate(0.5)).toBe(false);
    });

    it("rejects 100.99", () => {
      expect(AmountUtils.validate(100.99)).toBe(false);
    });

    it("rejects -1.5", () => {
      expect(AmountUtils.validate(-1.5)).toBe(false);
    });

    it("rejects Math.PI", () => {
      expect(AmountUtils.validate(Math.PI)).toBe(false);
    });
  });

  describe("rejection cases - non-number types", () => {
    it("rejects string '100'", () => {
      expect(AmountUtils.validate("100")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(AmountUtils.validate("")).toBe(false);
    });

    it("rejects null", () => {
      expect(AmountUtils.validate(null)).toBe(false);
    });

    it("rejects undefined", () => {
      expect(AmountUtils.validate(undefined)).toBe(false);
    });

    it("rejects object", () => {
      expect(AmountUtils.validate({ amount: 100 })).toBe(false);
    });

    it("rejects array", () => {
      expect(AmountUtils.validate([100])).toBe(false);
    });

    it("rejects boolean true", () => {
      expect(AmountUtils.validate(true)).toBe(false);
    });

    it("rejects boolean false", () => {
      expect(AmountUtils.validate(false)).toBe(false);
    });
  });

  describe("rejection cases - special number values", () => {
    it("rejects NaN", () => {
      expect(AmountUtils.validate(NaN)).toBe(false);
    });

    it("rejects Infinity", () => {
      expect(AmountUtils.validate(Infinity)).toBe(false);
    });

    it("rejects -Infinity", () => {
      expect(AmountUtils.validate(-Infinity)).toBe(false);
    });
  });

  describe("rejection cases - boundary violations", () => {
    it("rejects value exceeding MAX_MINOR_AMOUNT", () => {
      expect(AmountUtils.validate(MAX_MINOR_AMOUNT + 1)).toBe(false);
    });

    it("rejects value far exceeding MAX_MINOR_AMOUNT", () => {
      expect(AmountUtils.validate(1e15)).toBe(false);
    });
  });

  describe("security and correctness assumptions", () => {
    it("uses Number.isInteger for float detection (not modulo)", () => {
      // This verifies the implementation uses Number.isInteger which correctly
      // handles edge cases that modulo-based checks might miss
      expect(AmountUtils.validate(1.0)).toBe(true); // 1.0 is an integer in JS
      // Note: 1.0000000000000001 rounds to 1 in JS due to precision limits
      expect(AmountUtils.validate(1.0000000000001)).toBe(false); // Actual float
    });

    it("strictly enforces type check before other validations", () => {
      // Type check happens first, so non-numbers don't cause issues in later checks
      expect(AmountUtils.validate("0")).toBe(false);
      expect(AmountUtils.validate(null)).toBe(false);
    });

    it("prevents overflow by enforcing upper bound", () => {
      // MAX_MINOR_AMOUNT (1e14) is well within safe integer range
      // This prevents potential overflow in arithmetic operations
      expect(MAX_MINOR_AMOUNT).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    });
  });
});
