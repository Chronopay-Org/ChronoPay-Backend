/**
 * Tests for #476 – partial-refund tax-recalculation with jurisdiction-specific rules.
 */

import { describe, it, expect } from "@jest/globals";
import {
  TaxRefundCalculator,
  TaxRefundCalculatorError,
  resolveRule,
  validateRule,
  JurisdictionTaxRule,
  TaxRefundInput,
} from "../taxRefundCalculator.js";

// ─── Rule fixtures ────────────────────────────────────────────────────────────

const BASE_DATE = "2024-01-01T00:00:00Z";
const FUTURE_DATE = "2030-01-01T00:00:00Z";
const PAST_DATE = "2020-01-01T00:00:00Z";

const ruleDE: JurisdictionTaxRule = {
  jurisdictionCode: "DE",
  strategy: "full_proportional",
  effectiveFrom: BASE_DATE,
  metadata: { regulation: "EU-VAT-2006-112" },
};

const ruleUS: JurisdictionTaxRule = {
  jurisdictionCode: "US",
  strategy: "prorated",
  prorateCoefficient: 0.5,
  effectiveFrom: BASE_DATE,
};

const ruleUSCA: JurisdictionTaxRule = {
  jurisdictionCode: "US-CA",
  strategy: "prorated",
  prorateCoefficient: 0.75,
  effectiveFrom: BASE_DATE,
};

const expiredRule: JurisdictionTaxRule = {
  jurisdictionCode: "FR",
  strategy: "full_proportional",
  effectiveFrom: PAST_DATE,
  effectiveTo: "2022-01-01T00:00:00Z", // already expired
};

const futureRule: JurisdictionTaxRule = {
  jurisdictionCode: "JP",
  strategy: "prorated",
  prorateCoefficient: 0.8,
  effectiveFrom: FUTURE_DATE,
};

// ─── resolveRule ──────────────────────────────────────────────────────────────

describe("resolveRule", () => {
  const now = new Date("2025-06-15T00:00:00Z");

  it("returns exact match rule when available", () => {
    const rule = resolveRule([ruleUS, ruleUSCA], "US-CA", now);
    expect(rule?.jurisdictionCode).toBe("US-CA");
    expect(rule?.prorateCoefficient).toBe(0.75);
  });

  it("falls back to country prefix when no exact match", () => {
    const rule = resolveRule([ruleUS], "US-TX", now);
    expect(rule?.jurisdictionCode).toBe("US");
  });

  it("returns null when no active rule matches", () => {
    const rule = resolveRule([ruleDE], "AU", now);
    expect(rule).toBeNull();
  });

  it("returns null for expired rule", () => {
    const rule = resolveRule([expiredRule], "FR", now);
    expect(rule).toBeNull();
  });

  it("returns null for future rule that is not yet active", () => {
    const rule = resolveRule([futureRule], "JP", now);
    expect(rule).toBeNull();
  });

  it("resolves future rule once the date passes", () => {
    const future = new Date("2031-01-01T00:00:00Z");
    const rule = resolveRule([futureRule], "JP", future);
    expect(rule?.jurisdictionCode).toBe("JP");
  });

  it("prefers latest effectiveFrom when multiple rules overlap", () => {
    const older: JurisdictionTaxRule = {
      jurisdictionCode: "GB",
      strategy: "full_proportional",
      effectiveFrom: "2023-01-01T00:00:00Z",
    };
    const newer: JurisdictionTaxRule = {
      jurisdictionCode: "GB",
      strategy: "prorated",
      prorateCoefficient: 0.6,
      effectiveFrom: "2024-06-01T00:00:00Z",
    };
    const rule = resolveRule([older, newer], "GB", now);
    expect(rule?.effectiveFrom).toBe("2024-06-01T00:00:00Z");
    expect(rule?.strategy).toBe("prorated");
  });
});

// ─── validateRule ─────────────────────────────────────────────────────────────

describe("validateRule", () => {
  it("accepts valid full_proportional rule", () => {
    expect(() => validateRule(ruleDE)).not.toThrow();
  });

  it("accepts valid prorated rule", () => {
    expect(() => validateRule(ruleUS)).not.toThrow();
  });

  it("rejects prorated rule without prorateCoefficient", () => {
    expect(() =>
      validateRule({ jurisdictionCode: "AU", strategy: "prorated", effectiveFrom: BASE_DATE }),
    ).toThrow(TaxRefundCalculatorError);
  });

  it("rejects prorateCoefficient > 1", () => {
    expect(() =>
      validateRule({
        jurisdictionCode: "AU",
        strategy: "prorated",
        prorateCoefficient: 1.5,
        effectiveFrom: BASE_DATE,
      }),
    ).toThrow("INVALID_RULE");
  });

  it("rejects prorateCoefficient < 0", () => {
    expect(() =>
      validateRule({
        jurisdictionCode: "AU",
        strategy: "prorated",
        prorateCoefficient: -0.1,
        effectiveFrom: BASE_DATE,
      }),
    ).toThrow(TaxRefundCalculatorError);
  });

  it("rejects invalid effectiveFrom", () => {
    expect(() =>
      validateRule({ jurisdictionCode: "AU", strategy: "full_proportional", effectiveFrom: "not-a-date" }),
    ).toThrow(TaxRefundCalculatorError);
  });

  it("rejects effectiveTo before effectiveFrom", () => {
    expect(() =>
      validateRule({
        jurisdictionCode: "AU",
        strategy: "full_proportional",
        effectiveFrom: "2026-01-01T00:00:00Z",
        effectiveTo: "2025-01-01T00:00:00Z",
      }),
    ).toThrow(TaxRefundCalculatorError);
  });
});

// ─── TaxRefundCalculator ──────────────────────────────────────────────────────

describe("TaxRefundCalculator", () => {
  const asOf = "2025-06-15T00:00:00Z";

  describe("full_proportional strategy", () => {
    it("refunds the exact proportional tax", () => {
      const calc = new TaxRefundCalculator([ruleDE]);
      const result = calc.calculate({
        capturedAmountCents: 12000,
        subtotalCents: 10000,
        taxLines: [{ label: "VAT 19%", amountCents: 2000, jurisdictionCode: "DE" }],
        refundSubtotalCents: 5000,
        asOf,
      });

      expect(result.refundSubtotalCents).toBe(5000);
      expect(result.taxLineRefunds[0].proportionalTaxCents).toBe(1000); // 2000 * 5000/10000
      expect(result.taxLineRefunds[0].refundableTaxCents).toBe(1000);
      expect(result.totalTaxRefundCents).toBe(1000);
      expect(result.totalRefundCents).toBe(6000);
      expect(result.taxLineRefunds[0].strategyApplied).toBe("full_proportional");
    });

    it("handles full refund correctly", () => {
      const calc = new TaxRefundCalculator([ruleDE]);
      const result = calc.calculate({
        capturedAmountCents: 11900,
        subtotalCents: 10000,
        taxLines: [{ label: "VAT", amountCents: 1900, jurisdictionCode: "DE" }],
        refundSubtotalCents: 10000,
        asOf,
      });

      expect(result.taxLineRefunds[0].refundableTaxCents).toBe(1900);
      expect(result.totalRefundCents).toBe(11900);
    });
  });

  describe("prorated strategy", () => {
    it("multiplies proportional tax by prorateCoefficient", () => {
      const calc = new TaxRefundCalculator([ruleUS]);
      const result = calc.calculate({
        capturedAmountCents: 10800,
        subtotalCents: 10000,
        taxLines: [{ label: "Sales Tax", amountCents: 800, jurisdictionCode: "US" }],
        refundSubtotalCents: 5000,
        asOf,
      });

      // proportional = 800 * 5000/10000 = 400
      // prorated     = floor(400 * 0.5) = 200
      expect(result.taxLineRefunds[0].proportionalTaxCents).toBe(400);
      expect(result.taxLineRefunds[0].refundableTaxCents).toBe(200);
      expect(result.taxLineRefunds[0].prorateCoefficient).toBe(0.5);
      expect(result.totalRefundCents).toBe(5200);
    });

    it("uses most specific jurisdiction rule (US-CA over US)", () => {
      const calc = new TaxRefundCalculator([ruleUS, ruleUSCA]);
      const result = calc.calculate({
        capturedAmountCents: 10800,
        subtotalCents: 10000,
        taxLines: [{ label: "CA Sales Tax", amountCents: 800, jurisdictionCode: "US-CA" }],
        refundSubtotalCents: 4000,
        asOf,
      });

      // proportional = 800 * 4000/10000 = 320
      // US-CA coeff  = 0.75  → floor(320 * 0.75) = 240
      expect(result.taxLineRefunds[0].prorateCoefficient).toBe(0.75);
      expect(result.taxLineRefunds[0].refundableTaxCents).toBe(240);
    });
  });

  describe("multiple tax lines", () => {
    it("calculates each line independently and sums total", () => {
      const calc = new TaxRefundCalculator([ruleDE, ruleUS]);
      const result = calc.calculate({
        capturedAmountCents: 12800,
        subtotalCents: 10000,
        taxLines: [
          { label: "VAT", amountCents: 2000, jurisdictionCode: "DE" },
          { label: "Sales Tax", amountCents: 800, jurisdictionCode: "US" },
        ],
        refundSubtotalCents: 5000,
        asOf,
      });

      expect(result.taxLineRefunds).toHaveLength(2);
      // DE full_proportional: 2000 * 5000/10000 = 1000
      // US prorated 0.5:      800 * 5000/10000 * 0.5 = 200
      expect(result.totalTaxRefundCents).toBe(1200);
      expect(result.totalRefundCents).toBe(6200);
    });
  });

  describe("effective-date handling", () => {
    it("throws NO_RULE_FOUND when rule has not started yet", () => {
      const calc = new TaxRefundCalculator([futureRule]);
      expect(() =>
        calc.calculate({
          capturedAmountCents: 10000,
          subtotalCents: 8000,
          taxLines: [{ label: "JCT", amountCents: 2000, jurisdictionCode: "JP" }],
          refundSubtotalCents: 4000,
          asOf,
        }),
      ).toThrow("NO_RULE_FOUND");
    });

    it("throws NO_RULE_FOUND when rule has expired", () => {
      const calc = new TaxRefundCalculator([expiredRule]);
      expect(() =>
        calc.calculate({
          capturedAmountCents: 10000,
          subtotalCents: 8000,
          taxLines: [{ label: "TVA", amountCents: 2000, jurisdictionCode: "FR" }],
          refundSubtotalCents: 4000,
          asOf,
        }),
      ).toThrow("NO_RULE_FOUND");
    });
  });

  describe("input validation", () => {
    const base: TaxRefundInput = {
      capturedAmountCents: 12000,
      subtotalCents: 10000,
      taxLines: [{ label: "VAT", amountCents: 2000, jurisdictionCode: "DE" }],
      refundSubtotalCents: 5000,
      asOf,
    };

    it("rejects negative capturedAmountCents", () => {
      const calc = new TaxRefundCalculator([ruleDE]);
      expect(() => calc.calculate({ ...base, capturedAmountCents: -1 })).toThrow("INVALID_INPUT");
    });

    it("rejects refundSubtotalCents > subtotalCents", () => {
      const calc = new TaxRefundCalculator([ruleDE]);
      expect(() =>
        calc.calculate({ ...base, refundSubtotalCents: 11000 }),
      ).toThrow("INVALID_INPUT");
    });

    it("rejects non-integer amountCents on taxLine", () => {
      const calc = new TaxRefundCalculator([ruleDE]);
      expect(() =>
        calc.calculate({
          ...base,
          taxLines: [{ label: "VAT", amountCents: 19.99, jurisdictionCode: "DE" }],
        }),
      ).toThrow("INVALID_INPUT");
    });

    it("throws NO_RULE_FOUND for unknown jurisdiction", () => {
      const calc = new TaxRefundCalculator([ruleDE]);
      expect(() =>
        calc.calculate({
          ...base,
          taxLines: [{ label: "GST", amountCents: 500, jurisdictionCode: "AU" }],
        }),
      ).toThrow("NO_RULE_FOUND");
    });
  });

  describe("floor rounding", () => {
    it("floors fractional cents to avoid over-refund", () => {
      // 1001 * 3000 / 10000 = 300.3 → floor = 300
      const calc = new TaxRefundCalculator([ruleDE]);
      const result = calc.calculate({
        capturedAmountCents: 13001,
        subtotalCents: 10000,
        taxLines: [{ label: "VAT", amountCents: 1001, jurisdictionCode: "DE" }],
        refundSubtotalCents: 3000,
        asOf,
      });

      expect(result.taxLineRefunds[0].refundableTaxCents).toBe(300);
    });
  });

  describe("zero subtotal edge case", () => {
    it("returns 0 tax refund when subtotal is zero", () => {
      const calc = new TaxRefundCalculator([ruleDE]);
      const result = calc.calculate({
        capturedAmountCents: 0,
        subtotalCents: 0,
        taxLines: [{ label: "VAT", amountCents: 0, jurisdictionCode: "DE" }],
        refundSubtotalCents: 0,
        asOf,
      });

      expect(result.totalTaxRefundCents).toBe(0);
      expect(result.totalRefundCents).toBe(0);
    });
  });

  describe("rule metadata", () => {
    it("includes metadata from the applied rule in the result", () => {
      const calc = new TaxRefundCalculator([ruleDE]);
      const result = calc.calculate({
        capturedAmountCents: 11900,
        subtotalCents: 10000,
        taxLines: [{ label: "VAT", amountCents: 1900, jurisdictionCode: "DE" }],
        refundSubtotalCents: 5000,
        asOf,
      });

      expect(result.taxLineRefunds[0].appliedRule.metadata?.regulation).toBe("EU-VAT-2006-112");
    });
  });
});
