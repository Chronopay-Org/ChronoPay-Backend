import { Currency } from "../types/checkout.js";

export type RefundRuleType = "fixed" | "percent";

export interface RefundRule {
  type: RefundRuleType;
  /**
   * For 'fixed', value is the deduction amount in minor integer units.
   * For 'percent', value is the percentage to deduct (0 to 100).
   */
  value: number;
}

export type RoundingPolicy = "half-to-even" | "half-up" | "truncate";

export const CURRENCY_ROUNDING_POLICY: Record<Currency, RoundingPolicy> = {
  USD: "half-to-even",
  EUR: "half-to-even",
  GBP: "half-to-even",
  XLM: "truncate", // Cryptocurrencies often truncate or use different rules; using truncate as an example of per-currency policy
};

export class PartialRefundCalculator {
  /**
   * Calculates the partial refund amount after applying the rules.
   * Precedence: 'fixed' deductions are applied first, followed by 'percent' deductions.
   *
   * @param originalAmount Original amount in integer minor units
   * @param rules Array of refund rules (deductions)
   * @param currency The currency (determines rounding policy)
   * @returns The net refund amount in integer minor units
   */
  static calculate(originalAmount: number, rules: RefundRule[], currency: Currency): number {
    if (!Number.isInteger(originalAmount) || originalAmount < 0) {
      throw new Error("originalAmount must be a non-negative integer");
    }

    // Validate rules
    for (const rule of rules) {
      if (rule.type === "percent" && (rule.value < 0 || rule.value > 100)) {
        throw new Error("Percent rule value must be between 0 and 100");
      }
      if (rule.type === "fixed" && (!Number.isInteger(rule.value) || rule.value < 0)) {
        throw new Error("Fixed rule value must be a non-negative integer");
      }
    }

    // Precedence: Fixed first, then Percent
    const fixedRules = rules.filter((r) => r.type === "fixed");
    const percentRules = rules.filter((r) => r.type === "percent");

    let currentAmount = originalAmount;

    // Apply fixed deductions
    for (const rule of fixedRules) {
      currentAmount -= rule.value;
      if (currentAmount < 0) {
        currentAmount = 0;
      }
    }

    // Apply percent deductions
    for (const rule of percentRules) {
      const deduction = currentAmount * (rule.value / 100);
      currentAmount -= deduction;
    }

    if (currentAmount < 0) {
      currentAmount = 0;
    }

    return this.applyRounding(currentAmount, CURRENCY_ROUNDING_POLICY[currency]);
  }

  private static applyRounding(amount: number, policy: RoundingPolicy): number {
    switch (policy) {
      case "half-to-even":
        return this.roundHalfToEven(amount);
      case "half-up":
        return Math.round(amount);
      case "truncate":
        return Math.trunc(amount);
      default:
        throw new Error(`Unsupported rounding policy: ${policy}`);
    }
  }

  /**
   * Banker's Rounding: rounds to the nearest integer.
   * If exactly halfway, rounds to the nearest even integer.
   */
  private static roundHalfToEven(num: number): number {
    const integerPart = Math.floor(num);
    const fraction = num - integerPart;

    if (fraction < 0.5) return integerPart;
    if (fraction > 0.5) return integerPart + 1;

    // Exactly 0.5
    return integerPart % 2 === 0 ? integerPart : integerPart + 1;
  }
}
