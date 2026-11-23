/**
 * Instant Payout Fee Schedule
 *
 * Computes fees per payout based on supplier tier, with monthly cap enforcement.
 * Each fee calculation produces an auditable snapshot.
 *
 * Tiers:
 *   basic    – standard fee rate
 *   premium  – discounted fee rate
 *   unlisted – lowest fee rate (negotiated)
 */

// ─── Core types ─────────────────────────────────────────────────────────────

export type TierId = "basic" | "premium" | "unlisted";

export interface TierFeeConfig {
  /** Fee as basis points (1 = 0.01%). E.g. 150 = 1.5%. */
  basisPoints: number;
  /** Flat fee in the smallest currency unit (e.g. cents). Added on top of basis-point fee. */
  flatFee: number;
  /** Monthly cap in the smallest currency unit. 0 = no cap. */
  monthlyCap: number;
}

export interface FeeScheduleConfig {
  basic: TierFeeConfig;
  premium: TierFeeConfig;
  unlisted: TierFeeConfig;
}

export interface CalculateFeeInput {
  supplierId: string;
  tier: TierId;
  /** Payout amount in the smallest currency unit. */
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
}

export interface FeeCalculationResult {
  /** The fee charged, in the smallest currency unit. */
  fee: number;
  /** Fee expressed in basis points (from the tier config). */
  feeBasisPoints: number;
  /** Flat fee component. */
  flatFee: number;
  /** Whether the monthly cap was reached and fee was zeroed. */
  capped: boolean;
  /** Remaining allowance this month after this payout. Infinity if no cap. */
  capRemaining: number;
  /** Total accrued this month before this payout. */
  monthlyAccrual: number;
  /** Maximum monthly cap for this tier. Infinity if no cap. */
  monthlyCap: number;
  /** Supplier tier used. */
  tier: TierId;
  /** Full input snapshot for auditability. */
  snapshot: {
    supplierId: string;
    tier: TierId;
    amount: number;
    currency: string;
    calculatedAt: string;
  };
}

// ─── Default fee schedule ────────────────────────────────────────────────────

const DEFAULT_SCHEDULE: FeeScheduleConfig = {
  basic: {
    basisPoints: 150,   // 1.5%
    flatFee: 0,
    monthlyCap: 50_000, // $500.00
  },
  premium: {
    basisPoints: 100,   // 1.0%
    flatFee: 0,
    monthlyCap: 200_000, // $2,000.00
  },
  unlisted: {
    basisPoints: 50,    // 0.5%
    flatFee: 0,
    monthlyCap: 0,      // no cap
  },
};

// ─── Monthly accrual tracking ────────────────────────────────────────────────

interface AccrualEntry {
  total: number;
  monthKey: string;
}

const accruals = new Map<string, AccrualEntry>();

function getMonthKey(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getAccrualKey(supplierId: string, currency: string): string {
  return `${supplierId}:${currency}`;
}

function getCurrentAccrual(supplierId: string, currency: string): number {
  const key = getAccrualKey(supplierId, currency);
  const entry = accruals.get(key);

  if (!entry || entry.monthKey !== getMonthKey()) {
    return 0;
  }

  return entry.total;
}

function addAccrual(supplierId: string, currency: string, amount: number): number {
  const key = getAccrualKey(supplierId, currency);
  const currentMonth = getMonthKey();
  const entry = accruals.get(key);

  if (!entry || entry.monthKey !== currentMonth) {
    accruals.set(key, { total: amount, monthKey: currentMonth });
    return amount;
  }

  entry.total += amount;
  return entry.total;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateInput(input: CalculateFeeInput): void {
  if (!input.supplierId || typeof input.supplierId !== "string") {
    throw new Error("supplierId must be a non-empty string");
  }
  if (!input.currency || typeof input.currency !== "string") {
    throw new Error("currency must be a non-empty string");
  }
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new Error(`amount must be a non-negative finite number, got ${input.amount}`);
  }
  if (!Number.isInteger(input.amount)) {
    throw new Error(`amount must be an integer (smallest currency unit), got ${input.amount}`);
  }
  if (!["basic", "premium", "unlisted"].includes(input.tier)) {
    throw new Error(`Unknown tier: "${input.tier}"`);
  }
}

// ─── Fee calculation ─────────────────────────────────────────────────────────

export function calculateFee(
  input: CalculateFeeInput,
  schedule: FeeScheduleConfig = DEFAULT_SCHEDULE,
): FeeCalculationResult {
  validateInput(input);

  const tierConfig = schedule[input.tier];
  if (!tierConfig) {
    throw new Error(`No fee configuration for tier: "${input.tier}"`);
  }

  const basisFee = Math.round((input.amount * tierConfig.basisPoints) / 10_000);
  const totalFee = basisFee + tierConfig.flatFee;

  const monthlyCap = tierConfig.monthlyCap;
  const accrualBefore = getCurrentAccrual(input.supplierId, input.currency);
  const accrualAfter = accrualBefore + totalFee;

  let finalFee = totalFee;
  let capped = false;
  let capRemaining = Infinity;

  if (monthlyCap > 0) {
    capRemaining = Math.max(0, monthlyCap - accrualBefore);

    if (accrualBefore >= monthlyCap) {
      finalFee = 0;
      capped = true;
      capRemaining = 0;
    } else if (accrualAfter > monthlyCap) {
      finalFee = Math.max(0, monthlyCap - accrualBefore);
      capped = true;
      capRemaining = 0;
    } else {
      capRemaining = monthlyCap - accrualAfter;
    }
  }

  if (finalFee > 0) {
    addAccrual(input.supplierId, input.currency, finalFee);
  }

  return {
    fee: finalFee,
    feeBasisPoints: tierConfig.basisPoints,
    flatFee: tierConfig.flatFee,
    capped,
    capRemaining,
    monthlyAccrual: accrualBefore + finalFee,
    monthlyCap,
    tier: input.tier,
    snapshot: {
      supplierId: input.supplierId,
      tier: input.tier,
      amount: input.amount,
      currency: input.currency,
      calculatedAt: new Date().toISOString(),
    },
  };
}

// ─── Query helpers ───────────────────────────────────────────────────────────

export function getMonthlyAccrual(supplierId: string, currency: string): number {
  return getCurrentAccrual(supplierId, currency);
}

export function getSchedule(): FeeScheduleConfig {
  return { ...DEFAULT_SCHEDULE };
}

export function listTiers(): TierId[] {
  return ["basic", "premium", "unlisted"];
}

export function getTierConfig(tier: TierId): TierFeeConfig {
  const config = DEFAULT_SCHEDULE[tier];
  if (!config) {
    throw new Error(`Unknown tier: "${tier}"`);
  }
  return { ...config };
}

/**
 * Reset accruals for testing.
 */
export function _resetAccrualsForTesting(): void {
  accruals.clear();
}
