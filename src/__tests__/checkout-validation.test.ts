/**
 * Checkout Validation Tests
 * 
 * Tests for input validation functions and edge cases
 */

import {
  isValidEmail,
  isValidAmount,
  isValidCurrency,
  isValidPaymentMethod,
  isValidCustomerId,
} from "../middleware/checkout-validation.js";

describe("Checkout Validation Functions", () => {
  describe("isValidEmail", () => {
    it("should accept valid emails", () => {
      expect(isValidEmail("user@example.com")).toBe(true);
      expect(isValidEmail("john.doe@company.co.uk")).toBe(true);
      expect(isValidEmail("user+tag@example.com")).toBe(true);
      expect(isValidEmail("123@example.com")).toBe(true);
    });

    it("should reject invalid emails", () => {
      expect(isValidEmail("invalid")).toBe(false);
      expect(isValidEmail("@example.com")).toBe(false);
      expect(isValidEmail("user@")).toBe(false);
      expect(isValidEmail("user @example.com")).toBe(false);
      expect(isValidEmail("")).toBe(false);
    });

    it("should reject emails exceeding length limit", () => {
      const longEmail = "a".repeat(250) + "@example.com";
      expect(isValidEmail(longEmail)).toBe(false);
    });
  });

  describe("isValidAmount", () => {
    it("should accept valid amounts", () => {
      expect(isValidAmount(1)).toBe(true);
      expect(isValidAmount(999999999)).toBe(true);
      expect(isValidAmount(10000)).toBe(true);
    });

    it("should reject invalid amounts", () => {
      expect(isValidAmount(0)).toBe(false);
      expect(isValidAmount(-100)).toBe(false);
      expect(isValidAmount(100.5)).toBe(false);
      expect(isValidAmount("1000")).toBe(false);
      expect(isValidAmount(null)).toBe(false);
      expect(isValidAmount(undefined)).toBe(false);
    });

    it("should reject amounts exceeding limit", () => {
      expect(isValidAmount(1e9 + 1)).toBe(false);
      expect(isValidAmount(2e9)).toBe(false);
    });
  });

  describe("isValidCurrency", () => {
    it("should accept supported currencies", () => {
      expect(isValidCurrency("USD")).toBe(true);
      expect(isValidCurrency("EUR")).toBe(true);
      expect(isValidCurrency("GBP")).toBe(true);
      expect(isValidCurrency("XLM")).toBe(true);
    });

    it("should reject unsupported currencies", () => {
      expect(isValidCurrency("JPY")).toBe(false);
      expect(isValidCurrency("INR")).toBe(false);
      expect(isValidCurrency("usd")).toBe(false); // Case sensitive
      expect(isValidCurrency("")).toBe(false);
      expect(isValidCurrency(null)).toBe(false);
    });
  });

  describe("isValidPaymentMethod", () => {
    it("should accept supported payment methods", () => {
      expect(isValidPaymentMethod("credit_card")).toBe(true);
      expect(isValidPaymentMethod("bank_transfer")).toBe(true);
      expect(isValidPaymentMethod("crypto")).toBe(true);
    });

    it("should reject unsupported payment methods", () => {
      expect(isValidPaymentMethod("paypal")).toBe(false);
      expect(isValidPaymentMethod("apple_pay")).toBe(false);
      expect(isValidPaymentMethod("")).toBe(false);
      expect(isValidPaymentMethod(null)).toBe(false);
    });
  });

  describe("isValidCustomerId", () => {
    it("should accept valid customer IDs", () => {
      expect(isValidCustomerId("cust_123")).toBe(true);
      expect(isValidCustomerId("user-456")).toBe(true);
      expect(isValidCustomerId("user_789")).toBe(true);
      expect(isValidCustomerId("a")).toBe(true);
      expect(isValidCustomerId("abc123XYZ")).toBe(true);
    });

    it("should reject invalid customer IDs", () => {
      expect(isValidCustomerId("")).toBe(false);
      expect(isValidCustomerId("user@123")).toBe(false);
      expect(isValidCustomerId("user #123")).toBe(false);
      expect(isValidCustomerId("user.com")).toBe(false);
      expect(isValidCustomerId(null)).toBe(false);
      expect(isValidCustomerId(undefined)).toBe(false);
      expect(isValidCustomerId(123)).toBe(false);
    });

    it("should reject customer IDs exceeding length limit", () => {
      const longId = "a".repeat(256);
      expect(isValidCustomerId(longId)).toBe(false);
    });
  });
});
