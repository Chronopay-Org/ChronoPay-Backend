/**
 * Amount utility class enforcing deterministic rounding rules and minor-unit limits.
 * Protects against floating-point precision exploits and enforces integer boundaries natively.
 */

export type SupportedCurrencies = "USD" | "EUR" | "GBP" | "XLM";

export const CURRENCY_DECIMALS: Record<SupportedCurrencies, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  XLM: 7, // Stellar native precision
};

// Security boundary to prevent overflow on extreme limits.
// Max supported minor-unit: 100 Trillion (1e14)
export const MAX_MINOR_AMOUNT = 1e14;

export class AmountUtils {
  /**
   * Validates if a provided value is strictly a positive integer representing a native minor-unit.
   * Throws away strings, decimals, and negative coordinates immediately.
   * 
   * @param value The value to inspect
   */
  static validate(value: unknown): boolean {
    if (typeof value !== "number") return false;
    if (!Number.isInteger(value)) return false;
    if (value <= 0) return false;
    if (value > MAX_MINOR_AMOUNT) return false;
    return true;
  }

  /**
   * Addition of two minor units natively, with bound validation check
   * @throws Error if limits exceeded
   */
  static add(a: number, b: number): number {
    if (!this.validate(a)) throw new Error("Invalid base amount for addition");
    if (!this.validate(b)) throw new Error("Invalid addend amount for addition");

    const total = a + b;
    if (!this.validate(total)) throw new Error("Addition generated amount out of safe integer boundaries");
    return total;
  }

  /**
   * Calculates a fee securely from a given amount using a Basis Points (bps) scaling format.
   * A 1.5% fee = 150 basis points.
   * Rounds half-up securely enforcing deterministic returns.
   * 
   * @param amount The base minor unit amount
   * @param bps The basis points for the fee (10000 bps = 100%, 100 = 1%)
   */
  static calculateFee(amount: number, bps: number): number {
    if (!this.validate(amount)) throw new Error("Invalid amount for fee calculation");
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
      throw new Error("Invalid format: BPS must be integer between 0 and 10000");
    }

    const feeBase = (amount * bps) / 10000;
    // Utilize deterministic Math.round directly on positive integers to avoid float scaling bias correctly on halves
    const computedFee = Math.round(feeBase);
    
    return computedFee;
  }

  /**
   * Utility to safely parse a frontend major-unit decimal format string explicitly into a minor-unit format integer.
   * Note: Our middleware primarily enforces pure integers. This exists for utility scripting or internal conversions safely.
   */
  static parseFromMajorString(value: string, currency: SupportedCurrencies): number {
    const decimals = CURRENCY_DECIMALS[currency];
    if (decimals === undefined) throw new Error("Unsupported currency format");

    // Avoid parseFloat directly due to JS float mechanics. We split and parse integers manually.
    const decimalPattern = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
    if (!decimalPattern.test(value)) {
      throw new Error(`Invalid decimal format string to parse. Max allowed decimals for currency is ${decimals}`);
    }

    const parts = value.split(".");
    const major = parseInt(parts[0], 10);
    const minorStr = parts[1] || "";
    // Pad minor string to exact length of decimals
    const paddedMinorStr = minorStr.padEnd(decimals, "0");
    const minor = parseInt(paddedMinorStr, 10);

    const scale = Math.pow(10, decimals);
    const totalMinor = (major * scale) + minor;

    if (!this.validate(totalMinor)) throw new Error("Parsed amount failed integer validation safely");
    
    return totalMinor;
  }

  /**
   * Utility to format a minor-unit integer cleanly into a major-unit fixed decimal string format.
   */
  static formatToMajorString(amount: number, currency: SupportedCurrencies): string {
    if (!this.validate(amount)) throw new Error("Invalid amount for formatting");

    const decimals = CURRENCY_DECIMALS[currency];
    if (decimals === undefined) throw new Error("Unsupported currency format");

    const scale = Math.pow(10, decimals);
    const major = Math.floor(amount / scale);
    const minor = amount % scale;

    const minorStr = minor.toString().padStart(decimals, "0");
    return `${major}.${minorStr}`;
  }
}
