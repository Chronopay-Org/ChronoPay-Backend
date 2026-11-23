// @ts-nocheck
/**
 * partnerQuotaService.ts
 *
 * Per-token daily and monthly quota tracking with timezone-aware reset.
 *
 * Design decisions:
 *  - Quota rows are upserted on first use so there is no upfront provisioning.
 *    Default limits are applied on first creation; operators can UPDATE the
 *    row later to customise per partner.
 *  - Reset is lazy: checked on every access.  If `NOW() >= daily_reset_at`,
 *    the daily counter is zeroed and `daily_reset_at` is advanced to the next
 *    midnight in the partner's timezone.  Same for monthly.
 *  - Approaching-quota notification is emitted once per window when usage
 *    crosses 80 % of either limit.  A boolean flag prevents repeated alarms.
 *  - The service is stateless; all state lives in `partner_token_quotas`.
 */

import { partnerQuotaApproachingLimit, partnerQuotaExceededTotal } from "../metrics.js";
import { logger } from "../utils/logger.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface QuotaRow {
  token_id: string;
  daily_limit: number;
  monthly_limit: number;
  daily_used: number;
  monthly_used: number;
  daily_reset_at: Date;
  monthly_reset_at: Date;
  timezone: string;
  approaching_quota_notified: boolean;
  updated_at: Date;
  created_at: Date;
}

export interface QuotaStatus {
  tokenId: string;
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  dailyResetAt: string;
  monthlyResetAt: string;
  timezone: string;
  dailyPercentUsed: number;
  monthlyPercentUsed: number;
}

export interface ConsumeResult {
  allowed: boolean;
  status: QuotaStatus;
  exceeded: "daily" | "monthly" | "both" | null;
}

/**
 * Interface for the quota store.
 * Production uses SQL; tests use an in-memory implementation.
 */
export interface QuotaStore {
  /** Get or create a quota row for the given token. */
  getOrCreate(tokenId: string, now?: Date): Promise<QuotaRow>;
  /** Atomically increment the counters and update reset timestamps. */
  consume(
    tokenId: string,
    dailyResetAt: Date,
    monthlyResetAt: Date,
    approachingNotified: boolean,
    now?: Date,
  ): Promise<void>;
  /** Update the approaching-quota-notified flag. */
  markNotified(tokenId: string): Promise<void>;
}

// ─── Approaching-quota threshold ──────────────────────────────────────────────

const APPROACHING_THRESHOLD = 0.8; // 80 %

// ─── Timezone helpers ─────────────────────────────────────────────────────────

/**
 * Compute the next daily reset timestamp (midnight in the partner's timezone,
 * represented as a UTC Date).
 *
 * Strategy: get the current date in the target timezone, add 1 day, and
 * construct the UTC timestamp for midnight of that date in that timezone.
 */
export function nextDailyReset(timezone: string, now: Date = new Date()): Date {
  const { year, month, day } = getLocalDate(timezone, now);
  return midnightInTz(timezone, year, month, day + 1);
}

/**
 * Compute the next monthly reset timestamp (1st of next month in the partner's
 * timezone, represented as a UTC Date).
 */
export function nextMonthlyReset(timezone: string, now: Date = new Date()): Date {
  const { year, month } = getLocalDate(timezone, now);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return midnightInTz(timezone, nextYear, nextMonth, 1);
}

/**
 * Get the local date components for `now` in the given IANA timezone.
 */
function getLocalDate(timezone: string, now: Date): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = formatter.format(now).split("-").map(Number);
  return { year: y, month: m, day: d };
}

/**
 * Convert a date (year, month, day) at midnight in the target timezone to a
 * UTC Date object.
 *
 * Strategy: query the IANA timezone's UTC offset (via formatToParts with
 * timeZoneName) at noon on the target date, then compute midnight-in-that-tz
 * as:  UTC_midnight = UTC(year, month-1, day) - offsetMinutes * 60_000
 *
 * Offset convention (from timeZoneName "longOffset"):
 *   "UTC-4"   → offsetMinutes = -240  (4 hours BEHIND UTC)
 *   "UTC+5:30" → offsetMinutes = +330 (5h30 AHEAD of UTC)
 *   "UTC"     → offsetMinutes = 0
 *
 * Because UTC = local_time - offsetMinutes * 60_000, midnight in the target
 * timezone becomes:
 *   midnightUtc = Date.UTC(year, month-1, day) - offsetMinutes * 60_000
 */
function midnightInTz(timezone: string, year: number, month: number, day: number): Date {
  // Use a UTC-based input so host timezone does not distort the result.
  const noonUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(noonUtc));

  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "UTC";
  const offsetMinutes = parseOffset(tzPart);

  const midnightUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMinutes * 60_000;
  return new Date(midnightUtc);
}

/**
 * Parse a timezone offset string like "UTC+5:30", "UTC-4", "GMT-4", or just
 * "UTC" / "GMT" into minutes relative to UTC.
 *
 * Returns the number of minutes to ADD to local time to obtain UTC.
 * E.g. America/New_York (EDT, UTC-4) → -240  (add -240 min to local = UTC)
 *      Europe/London (BST, UTC+1)    → +60   (add +60 min to local = UTC)
 *
 * Handles formats:
 *   "UTC+5:30" / "GMT-4" / "UTC" / "GMT" / "EDT" / "BST"
 * Unknown abbreviations default to 0 (assume UTC).
 */
function parseOffset(tzName: string): number {
  // Named offsets or unknown abbreviations
  if (tzName === "UTC" || tzName === "GMT" || tzName === "Z") return 0;

  // Try "UTC+5:30", "UTC-4", "GMT+1", "GMT-4"
  const explicit = /(?:UTC|GMT)([+-])(\d+)(?::(\d+))?/.exec(tzName);
  if (explicit) {
    const sign = explicit[1] === "+" ? 1 : -1;
    const hours = parseInt(explicit[2], 10);
    const minutes = parseInt(explicit[3] ?? "0", 10);
    return sign * (hours * 60 + minutes);
  }

  // Common timezone abbreviation → offset map (abbreviated, non-exhaustive)
  const abbrMap: Record<string, number> = {
    // North America
    "EST": -300, "EDT": -240, "CST": -360, "CDT": -300,
    "MST": -420, "MDT": -360, "PST": -480, "PDT": -420,
    "AKST": -540, "AKDT": -480, "HST": -600, "HAST": -600,
    // Europe
    "GMT": 0, "BST": 60, "CET": 60, "CEST": 120,
    "EET": 120, "EEST": 180, "WET": 0, "WEST": 60,
    "IST": 60,  // Irish Summer Time / Israel Standard Time — context-dependent
    // Asia-Pacific
    "JST": 540, "KST": 540, "CST_CN": 480, "HKT": 480,
    "SGT": 480, "AEST": 600, "AEDT": 660, "ACST": 570,
    "ACDT": 630, "AWST": 480, "NZST": 720, "NZDT": 780,
    // India
    "IST_IN": 330,
  };

  return abbrMap[tzName] ?? 0;
}

// ─── SQL store ────────────────────────────────────────────────────────────────

export class SqlQuotaStore implements QuotaStore {
  constructor(private readonly pool: { query: Function }) {}

  async getOrCreate(tokenId: string, now?: Date): Promise<QuotaRow> {
    const _now = now ?? new Date();
    const result = await this.pool.query(
      `INSERT INTO partner_token_quotas (token_id, daily_reset_at, monthly_reset_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token_id) DO UPDATE SET
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [tokenId, nextDailyReset("UTC", _now), nextMonthlyReset("UTC", _now)],
    );
    return result.rows[0];
  }

  async consume(
    tokenId: string,
    dailyResetAt: Date,
    monthlyResetAt: Date,
    approachingNotified: boolean,
    _now?: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE partner_token_quotas SET
        daily_used = CASE
          WHEN $2::timestamptz > updated_at THEN 1
          ELSE daily_used + 1
        END,
        monthly_used = CASE
          WHEN $3::timestamptz > updated_at THEN 1
          ELSE monthly_used + 1
        END,
        daily_reset_at = $2,
        monthly_reset_at = $3,
        approaching_quota_notified = $4,
        updated_at = NOW()
       WHERE token_id = $1`,
      [tokenId, dailyResetAt, monthlyResetAt, approachingNotified],
    );
  }

  async markNotified(tokenId: string): Promise<void> {
    await this.pool.query(
      `UPDATE partner_token_quotas SET approaching_quota_notified = TRUE WHERE token_id = $1`,
      [tokenId],
    );
  }
}

// ─── In-memory store (for testing) ────────────────────────────────────────────

export class InMemoryQuotaStore implements QuotaStore {
  private readonly rows = new Map<string, QuotaRow>();

  async getOrCreate(tokenId: string, _now?: Date): Promise<QuotaRow> {
    let row = this.rows.get(tokenId);
    if (!row) {
      const now = _now ?? new Date();
      row = {
        token_id: tokenId,
        daily_limit: 10000,
        monthly_limit: 300000,
        daily_used: 0,
        monthly_used: 0,
        daily_reset_at: nextDailyReset("UTC", now),
        monthly_reset_at: nextMonthlyReset("UTC", now),
        timezone: "UTC",
        approaching_quota_notified: false,
        updated_at: now,
        created_at: now,
      };
      this.rows.set(tokenId, { ...row });
    }
    return { ...row };
  }

  async consume(
    tokenId: string,
    dailyResetAt: Date,
    monthlyResetAt: Date,
    approachingNotified: boolean,
    now?: Date,
  ): Promise<void> {
    const row = this.rows.get(tokenId);
    if (!row) return;

    const _now = now ?? new Date();

    // Reset daily if past daily_reset_at
    if (_now >= row.daily_reset_at) {
      row.daily_used = 1;
      row.daily_reset_at = dailyResetAt;
    } else {
      row.daily_used += 1;
    }

    // Reset monthly if past monthly_reset_at
    if (_now >= row.monthly_reset_at) {
      row.monthly_used = 1;
      row.monthly_reset_at = monthlyResetAt;
    } else {
      row.monthly_used += 1;
    }

    row.approaching_quota_notified = approachingNotified;
    row.updated_at = _now;
  }

  async markNotified(tokenId: string): Promise<void> {
    const row = this.rows.get(tokenId);
    if (row) {
      row.approaching_quota_notified = true;
    }
  }

  clear(): void {
    this.rows.clear();
  }
}

// ─── Quota status mapping ─────────────────────────────────────────────────────

function toQuotaStatus(row: QuotaRow): QuotaStatus {
  const dailyPercent = row.daily_limit > 0 ? (row.daily_used / row.daily_limit) * 100 : 0;
  const monthlyPercent = row.monthly_limit > 0 ? (row.monthly_used / row.monthly_limit) * 100 : 0;

  return {
    tokenId: row.token_id,
    dailyUsed: row.daily_used,
    dailyLimit: row.daily_limit,
    monthlyUsed: row.monthly_used,
    monthlyLimit: row.monthly_limit,
    dailyResetAt: row.daily_reset_at.toISOString(),
    monthlyResetAt: row.monthly_reset_at.toISOString(),
    timezone: row.timezone,
    dailyPercentUsed: Math.round(dailyPercent * 100) / 100,
    monthlyPercentUsed: Math.round(monthlyPercent * 100) / 100,
  };
}

// ─── Main service ─────────────────────────────────────────────────────────────

/**
 * Check and consume one unit of quota for the given token.
 *
 * Returns whether the request is allowed, the current quota status, and
 * which (if any) limit was exceeded.
 */
export async function checkAndConsume(
  tokenId: string,
  store: QuotaStore,
  now?: Date,
): Promise<ConsumeResult> {
  const _now = now ?? new Date();
  const row = await store.getOrCreate(tokenId, _now);

  // Determine if counters need resetting (lazy reset)
  const dailyReset = _now >= row.daily_reset_at;
  const monthlyReset = _now >= row.monthly_reset_at;

  const effectiveDailyUsed = dailyReset ? 0 : row.daily_used;
  const effectiveMonthlyUsed = monthlyReset ? 0 : row.monthly_used;

  // Check limits BEFORE consuming
  const dailyExceeded = effectiveDailyUsed >= row.daily_limit;
  const monthlyExceeded = effectiveMonthlyUsed >= row.monthly_limit;

  if (dailyExceeded || monthlyExceeded) {
    partnerQuotaExceededTotal.labels(row.token_id).inc();
    return {
      allowed: false,
      status: toQuotaStatus({
        ...row,
        daily_used: effectiveDailyUsed,
        monthly_used: effectiveMonthlyUsed,
        daily_reset_at: dailyReset ? nextDailyReset(row.timezone, _now) : row.daily_reset_at,
        monthly_reset_at: monthlyReset ? nextMonthlyReset(row.timezone, _now) : row.monthly_reset_at,
      }),
      exceeded: dailyExceeded && monthlyExceeded ? "both" : dailyExceeded ? "daily" : "monthly",
    };
  }

  // Compute next reset timestamps (may be same if no reset needed)
  const nextDaily = dailyReset ? nextDailyReset(row.timezone, _now) : row.daily_reset_at;
  const nextMonthly = monthlyReset ? nextMonthlyReset(row.timezone, _now) : row.monthly_reset_at;

  // Check approaching-quota threshold (>= 80 %)
  const nextDailyUsed = effectiveDailyUsed + 1;
  const nextMonthlyUsed = effectiveMonthlyUsed + 1;
  const approachingDaily = nextDailyUsed / row.daily_limit >= APPROACHING_THRESHOLD;
  const approachingMonthly = nextMonthlyUsed / row.monthly_limit >= APPROACHING_THRESHOLD;
  const shouldNotify = (approachingDaily || approachingMonthly) && !row.approaching_quota_notified;

  if (shouldNotify) {
    partnerQuotaApproachingLimit.labels(row.token_id).inc();
    logger.warn(
      { tokenId: row.token_id, dailyUsed: nextDailyUsed, dailyLimit: row.daily_limit, monthlyUsed: nextMonthlyUsed, monthlyLimit: row.monthly_limit },
      "partner quota: approaching limit",
    );
  }

  // Consume
  await store.consume(tokenId, nextDaily, nextMonthly, row.approaching_quota_notified || shouldNotify, _now);

  const updatedRow = await store.getOrCreate(tokenId, _now);
  return {
    allowed: true,
    status: toQuotaStatus(updatedRow),
    exceeded: null,
  };
}

/**
 * Get the current quota status for a token (read-only, no consumption).
 */
export async function getQuotaStatus(
  tokenId: string,
  store: QuotaStore,
  now?: Date,
): Promise<QuotaStatus> {
  const _now = now ?? new Date();
  const row = await store.getOrCreate(tokenId, _now);

  // Lazy reset — show effective usage
  const dailyReset = _now >= row.daily_reset_at;
  const monthlyReset = _now >= row.monthly_reset_at;

  return toQuotaStatus({
    ...row,
    daily_used: dailyReset ? 0 : row.daily_used,
    monthly_used: monthlyReset ? 0 : row.monthly_used,
    daily_reset_at: dailyReset ? nextDailyReset(row.timezone, _now) : row.daily_reset_at,
    monthly_reset_at: monthlyReset ? nextMonthlyReset(row.timezone, _now) : row.monthly_reset_at,
  });
}
