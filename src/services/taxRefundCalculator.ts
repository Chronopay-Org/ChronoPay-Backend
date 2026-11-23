/**
 * Tax Refund Calculator – Issue #476
 *
 * Produces a tax-adjusted refund record for partial refunds.  Tax treatment
 * differs by jurisdiction: some regions refund the full proportional tax on
 * the refunded amount; others prorate based on a configured coefficient.
 *
 * Design goals:
 *  - Rules are immutable value objects – no mutable global state.
 *  - Effective dates allow future rules to be pre-loaded without taking effect.
 *  - Integer-arithmetic throughout (amounts in cents/stroops, rates in basis points).
 *  - No raw env values or PII are leaked in errors.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * ISO 3166-1 alpha-2 country code extended with regional variants
 * (e.g., "US-CA" for California).
 */
export type JurisdictionCode = string;

/** Tax refund strategies supported by the engine. */
export type TaxRefundStrategy = "full_proportional" | "prorated";

/**
 * Per-jurisdiction rule that governs how tax is refunded.
 *
 * @property jurisdictionCode  ISO country (or region) code.
 * @property strategy          "full_proportional" – refund the exact tax
 *                             attributable to the refunded line items;
 *                             "prorated" – multiply by `prorateCoefficient`.
 * @property prorateCoefficient  Required when strategy is "prorated".
 *                               Value in [0, 1] expressed as a decimal fraction
 *                               (e.g., 0.75 = 75 % of the proportional tax is refunded).
 * @property effectiveFrom     ISO 8601 date-time string; rule is inactive before this.
 * @property effectiveTo       Optional ISO 8601 date-time string; rule expires after this.
 * @property metadata          Arbitrary key/value annotations (e.g., regulation reference).
 */
export interface JurisdictionTaxRule {
  jurisdictionCode: JurisdictionCode;
  strategy: TaxRefundStrategy;
  prorateCoefficient?: number; // required when strategy === "prorated"
  effectiveFrom: string; // ISO 8601
  effectiveTo?: string; // ISO 8601, open-ended if absent
  metadata?: Record<string, string>;
}

/**
 * Breakdown of a single tax line within a transaction.
 */
export interface TaxLine {
  /** Human-readable label (e.g., "VAT", "GST", "Sales Tax"). */
  label: string;
  /** Tax amount in the transaction's minor unit (cents / stroops). */
  amountCents: number;
  /** Jurisdiction this line belongs to. */
  jurisdictionCode: JurisdictionCode;
}

/**
 * Input to the tax refund calculation.
 */
export interface TaxRefundInput {
  /** Total captured amount in minor units (before any refund). */
  capturedAmountCents: number;
  /** Subtotal (pre-tax) in minor units. */
  subtotalCents: number;
  /** Tax lines associated with the original transaction. */
  taxLines: TaxLine[];
  /** Amount the merchant wants to refund (pre-tax / subtotal portion) in minor units. */
  refundSubtotalCents: number;
  /** ISO 8601 date-time to evaluate rules at (defaults to now). */
  asOf?: string;
}

/**
 * Per-tax-line refund record.
 */
export interface TaxLineRefund {
  label: string;
  jurisdictionCode: JurisdictionCode;
  /** Tax amount attributed to the refunded subtotal (before proration). */
  proportionalTaxCents: number;
  /** Final refundable tax after applying the jurisdiction rule. */
  refundableTaxCents: number;
  strategyApplied: TaxRefundStrategy;
  prorateCoefficient?: number;
  /** The rule that governed this calculation. */
  appliedRule: JurisdictionTaxRule;
}

/**
 * Complete output of a tax-adjusted refund calculation.
 */
export interface TaxAdjustedRefundRecord {
  refundSubtotalCents: number;
  taxLineRefunds: TaxLineRefund[];
  totalTaxRefundCents: number;
  /** refundSubtotalCents + totalTaxRefundCents */
  totalRefundCents: number;
  calculatedAt: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class TaxRefundCalculatorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "TaxRefundCalculatorError";
  }
}

// ─── Rule registry helpers ────────────────────────────────────────────────────

/**
 * Returns the most specific active rule for a jurisdiction at the given moment.
 *
 * Specificity order: exact code > country prefix (e.g., "US" matches "US-CA")
 * When multiple rules have the same specificity and overlap in time, the one
 * with the latest `effectiveFrom` wins (most recently enacted rule takes precedence).
 */
export function resolveRule(
  rules: JurisdictionTaxRule[],
  jurisdictionCode: JurisdictionCode,
  asOf: Date,
): JurisdictionTaxRule | null {
  const asOfMs = asOf.getTime();

  const active = rules.filter((r) => {
    const from = new Date(r.effectiveFrom).getTime();
    const to = r.effectiveTo ? new Date(r.effectiveTo).getTime() : Infinity;
    return from <= asOfMs && asOfMs < to;
  });

  // Exact code match has higher specificity than prefix match
  const exactMatches = active.filter((r) => r.jurisdictionCode === jurisdictionCode);
  const prefixMatches = active.filter(
    (r) =>
      r.jurisdictionCode !== jurisdictionCode &&
      jurisdictionCode.startsWith(r.jurisdictionCode + "-"),
  );

  const candidates = exactMatches.length > 0 ? exactMatches : prefixMatches;
  if (candidates.length === 0) return null;

  // Latest effectiveFrom wins among candidates of equal specificity
  return candidates.reduce((best, r) =>
    new Date(r.effectiveFrom) > new Date(best.effectiveFrom) ? r : best,
  );
}

/**
 * Validate a rule definition at registration time.
 * Throws `TaxRefundCalculatorError` with code `INVALID_RULE` on failure.
 */
export function validateRule(rule: JurisdictionTaxRule): void {
  if (!rule.jurisdictionCode || typeof rule.jurisdictionCode !== "string") {
    throw new TaxRefundCalculatorError(
      "jurisdictionCode must be a non-empty string",
      "INVALID_RULE",
    );
  }
  if (rule.strategy !== "full_proportional" && rule.strategy !== "prorated") {
    throw new TaxRefundCalculatorError(
      `Unknown strategy: ${rule.strategy}`,
      "INVALID_RULE",
    );
  }
  if (rule.strategy === "prorated") {
    if (
      rule.prorateCoefficient === undefined ||
      typeof rule.prorateCoefficient !== "number" ||
      rule.prorateCoefficient < 0 ||
      rule.prorateCoefficient > 1
    ) {
      throw new TaxRefundCalculatorError(
        "prorateCoefficient must be a number in [0, 1] for prorated strategy",
        "INVALID_RULE",
      );
    }
  }
  if (!rule.effectiveFrom || isNaN(new Date(rule.effectiveFrom).getTime())) {
    throw new TaxRefundCalculatorError(
      "effectiveFrom must be a valid ISO 8601 date-time",
      "INVALID_RULE",
    );
  }
  if (rule.effectiveTo !== undefined && isNaN(new Date(rule.effectiveTo).getTime())) {
    throw new TaxRefundCalculatorError(
      "effectiveTo must be a valid ISO 8601 date-time",
      "INVALID_RULE",
    );
  }
  if (rule.effectiveTo && new Date(rule.effectiveTo) <= new Date(rule.effectiveFrom)) {
    throw new TaxRefundCalculatorError(
      "effectiveTo must be after effectiveFrom",
      "INVALID_RULE",
    );
  }
}

// ─── Calculator ───────────────────────────────────────────────────────────────

/**
 * TaxRefundCalculator computes a tax-adjusted refund record from a registry
 * of jurisdiction rules.
 *
 * @example
 * ```ts
 * const calc = new TaxRefundCalculator([
 *   { jurisdictionCode: "DE", strategy: "full_proportional", effectiveFrom: "2024-01-01T00:00:00Z" },
 *   { jurisdictionCode: "US-CA", strategy: "prorated", prorateCoefficient: 0.5, effectiveFrom: "2024-01-01T00:00:00Z" },
 * ]);
 *
 * const record = calc.calculate({
 *   capturedAmountCents: 12000,
 *   subtotalCents: 10000,
 *   taxLines: [{ label: "VAT", amountCents: 2000, jurisdictionCode: "DE" }],
 *   refundSubtotalCents: 5000,
 * });
 * // record.totalRefundCents === 6000  (5000 subtotal + 1000 full VAT)
 * ```
 */
export class TaxRefundCalculator {
  private readonly rules: JurisdictionTaxRule[];

  constructor(rules: JurisdictionTaxRule[] = []) {
    for (const rule of rules) {
      validateRule(rule);
    }
    this.rules = [...rules];
  }

  /**
   * Register an additional rule at runtime.  Validates before inserting.
   */
  addRule(rule: JurisdictionTaxRule): void {
    validateRule(rule);
    this.rules.push(rule);
  }

  /**
   * Compute a tax-adjusted refund record.
   *
   * Rounding: integer floor throughout to avoid over-refunding.
   *
   * @throws TaxRefundCalculatorError  INVALID_INPUT on bad inputs.
   * @throws TaxRefundCalculatorError  NO_RULE_FOUND when no active rule covers a tax line's jurisdiction.
   */
  calculate(input: TaxRefundInput): TaxAdjustedRefundRecord {
    this.validateInput(input);

    const asOf = input.asOf ? new Date(input.asOf) : new Date();

    const taxLineRefunds: TaxLineRefund[] = [];
    let totalTaxRefundCents = 0;

    for (const line of input.taxLines) {
      const rule = resolveRule(this.rules, line.jurisdictionCode, asOf);
      if (!rule) {
        throw new TaxRefundCalculatorError(
          `No active tax rule found for jurisdiction: ${line.jurisdictionCode}`,
          "NO_RULE_FOUND",
        );
      }

      // Proportional tax = tax_line * (refund_subtotal / subtotal)
      // Use floor to avoid over-refunding.
      const proportionalTaxCents =
        input.subtotalCents === 0
          ? 0
          : Math.floor((line.amountCents * input.refundSubtotalCents) / input.subtotalCents);

      let refundableTaxCents: number;
      if (rule.strategy === "full_proportional") {
        refundableTaxCents = proportionalTaxCents;
      } else {
        // "prorated": multiply by the jurisdiction coefficient, floor again
        refundableTaxCents = Math.floor(proportionalTaxCents * (rule.prorateCoefficient ?? 0));
      }

      totalTaxRefundCents += refundableTaxCents;

      taxLineRefunds.push({
        label: line.label,
        jurisdictionCode: line.jurisdictionCode,
        proportionalTaxCents,
        refundableTaxCents,
        strategyApplied: rule.strategy,
        ...(rule.strategy === "prorated"
          ? { prorateCoefficient: rule.prorateCoefficient }
          : {}),
        appliedRule: rule,
      });
    }

    return {
      refundSubtotalCents: input.refundSubtotalCents,
      taxLineRefunds,
      totalTaxRefundCents,
      totalRefundCents: input.refundSubtotalCents + totalTaxRefundCents,
      calculatedAt: new Date().toISOString(),
    };
  }

  private validateInput(input: TaxRefundInput): void {
    if (
      typeof input.capturedAmountCents !== "number" ||
      !Number.isInteger(input.capturedAmountCents) ||
      input.capturedAmountCents < 0
    ) {
      throw new TaxRefundCalculatorError(
        "capturedAmountCents must be a non-negative integer",
        "INVALID_INPUT",
      );
    }
    if (
      typeof input.subtotalCents !== "number" ||
      !Number.isInteger(input.subtotalCents) ||
      input.subtotalCents < 0
    ) {
      throw new TaxRefundCalculatorError(
        "subtotalCents must be a non-negative integer",
        "INVALID_INPUT",
      );
    }
    if (
      typeof input.refundSubtotalCents !== "number" ||
      !Number.isInteger(input.refundSubtotalCents) ||
      input.refundSubtotalCents < 0
    ) {
      throw new TaxRefundCalculatorError(
        "refundSubtotalCents must be a non-negative integer",
        "INVALID_INPUT",
      );
    }
    if (input.refundSubtotalCents > input.subtotalCents) {
      throw new TaxRefundCalculatorError(
        "refundSubtotalCents cannot exceed subtotalCents",
        "INVALID_INPUT",
      );
    }
    if (!Array.isArray(input.taxLines)) {
      throw new TaxRefundCalculatorError("taxLines must be an array", "INVALID_INPUT");
    }
    for (const line of input.taxLines) {
      if (
        typeof line.amountCents !== "number" ||
        !Number.isInteger(line.amountCents) ||
        line.amountCents < 0
      ) {
        throw new TaxRefundCalculatorError(
          `taxLine "${line.label}" amountCents must be a non-negative integer`,
          "INVALID_INPUT",
        );
      }
    }
    if (input.asOf !== undefined && isNaN(new Date(input.asOf).getTime())) {
      throw new TaxRefundCalculatorError("asOf must be a valid ISO 8601 date-time", "INVALID_INPUT");
    }
  }
}
