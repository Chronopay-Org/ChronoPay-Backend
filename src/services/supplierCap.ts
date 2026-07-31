/**
 * @file src/services/supplierCap.ts
 *
 * Per-supplier daily booking-intent cap (issue #585).
 *
 * The counter lives in Redis, keyed `supplier:{id}:booking:{yyyy-mm-dd}`, with a
 * 26 h TTL so the key survives a short clock skew into the next day. Every
 * booking-intent create for a supplier INCRs the counter; once `used > cap` the
 * create is rejected with HTTP 429 and an `X-DailyCap-Reset` header.
 *
 * Fail-open contract: if Redis is unavailable (or errors), the cap check is a
 * no-op — we never want an infrastructure blip to block legitimate bookings.
 *
 * Admin overrides live in an in-memory store (mirroring the repo's other
 * per-supplier override stores, e.g. `supplierCancellationOverrideStore.ts`) and
 * are managed through `PUT/GET/DELETE /api/v1/admin/suppliers/:id/booking-cap`.
 * An override of `0` acts as a soft block (all creates rejected).
 */

import { AppError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { AuditLogger, defaultAuditLogger } from "./auditLogger.js";
import { getRedisClient, type RedisClient } from "../cache/redisClient.js";
import { logger } from "../utils/logger.js";

/** Default maximum booking-intents per supplier per UTC day. */
export const DEFAULT_SUPPLIER_DAILY_BOOKING_CAP = 500;

/** Redis TTL for the daily counter key (26 h, per issue #585). */
export const SUPPLIER_DAILY_CAP_KEY_TTL_SECONDS = 26 * 60 * 60;

/** Upper bound for an admin-configured cap (sanity guard against typos). */
export const MAX_SUPPLIER_DAILY_BOOKING_CAP = 1_000_000;

/** Redis key for a supplier's daily booking counter. */
export function supplierDailyCapKey(supplierId: string, dateKey: string): string {
  return `supplier:${supplierId}:booking:${dateKey}`;
}

/** `yyyy-mm-dd` in UTC for the given date. */
export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Start of the next UTC day, as an ISO timestamp. */
export function nextUtcMidnight(date: Date): string {
  const next = new Date(date.getTime());
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

/** An admin-configured override of the default per-supplier daily cap. */
export interface SupplierBookingCapOverride {
  supplierId: string;
  dailyCap: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  description?: string;
}

/** Snapshot of a supplier's current daily booking usage. */
export interface BookingCapUsage {
  supplierId: string;
  used: number;
  cap: number;
  /** ISO timestamp of the next UTC-day boundary (when the window resets). */
  resetAt: string;
}

/** The counter key carries a per-day window, so reset = start of next UTC day. */
export function computeBookingCapReset(now: Date): string {
  return nextUtcMidnight(now);
}

/**
 * Thrown when a supplier has exhausted their daily booking cap. `details`
 * carries the usage snapshot so callers can emit the `X-DailyCap-Reset` header.
 */
export class SupplierDailyCapExceededError extends AppError {
  readonly usage: BookingCapUsage;

  constructor(usage: BookingCapUsage) {
    super(
      `Daily booking cap of ${usage.cap} reached for supplier ${usage.supplierId}.`,
      429,
      ERROR_CODES.RATE_LIMITED.code,
      true,
      usage,
    );
    this.name = "SupplierDailyCapExceededError";
    this.usage = usage;
  }
}

export interface SupplierBookingCapServiceOptions {
  /** Source of the shared Redis client. Defaults to `getRedisClient`. */
  getRedis?: () => RedisClient | null;
  /** Injectable clock; default `new Date().toISOString()`. */
  nowIso?: () => string;
  /** Injectable audit logger; defaults to `defaultAuditLogger`. */
  auditLogger?: AuditLogger;
  /** Seed overrides (used by tests). */
  seed?: SupplierBookingCapOverride[];
}

export class SupplierBookingCapService {
  private readonly getRedis: () => RedisClient | null;
  private readonly nowIso: () => string;
  private readonly auditLogger: AuditLogger;
  private readonly overrides: Map<string, SupplierBookingCapOverride>;
  private readonly defaultCap: number;

  constructor(options: SupplierBookingCapServiceOptions = {}) {
    this.getRedis = options.getRedis ?? getRedisClient;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.auditLogger = options.auditLogger ?? defaultAuditLogger;
    this.overrides = new Map();
    this.defaultCap = DEFAULT_SUPPLIER_DAILY_BOOKING_CAP;
    if (options.seed) {
      for (const override of options.seed) {
        this.overrides.set(override.supplierId, { ...override });
      }
    }
  }

  /** Effective daily cap for a supplier (admin override, else the default). */
  resolveCap(supplierId: string): number {
    const override = this.overrides.get(supplierId);
    return override ? override.dailyCap : this.defaultCap;
  }

  /**
   * Atomically consume one booking slot for the supplier for the current UTC
   * day and check the cap. Returns `null` when the cap cannot be enforced
   * (Redis unavailable/error) — a deliberate fail-open. Throws
   * {@link SupplierDailyCapExceededError} when the cap is exceeded.
   */
  async increment(supplierId: string): Promise<BookingCapUsage | null> {
    if (typeof supplierId !== "string" || supplierId.trim().length === 0) {
      return null;
    }

    const redis = this.getRedis();
    if (!redis) {
      return null;
    }

    const now = new Date(this.nowIso());
    const key = supplierDailyCapKey(supplierId, utcDateKey(now));

    let used: number;
    try {
      used = await redis.incr(key);
      if (used === 1) {
        await redis.expire(key, SUPPLIER_DAILY_CAP_KEY_TTL_SECONDS);
      }
    } catch (error) {
      // Fail open: a Redis blip must never block legitimate bookings.
      logger.error(
        { err: error, supplierId },
        "supplier-booking-cap: redis error, cap enforcement skipped",
      );
      return null;
    }

    const cap = this.resolveCap(supplierId);
    const resetAt = computeBookingCapReset(now);
    const usage: BookingCapUsage = { supplierId, used, cap, resetAt };

    if (used > cap) {
      throw new SupplierDailyCapExceededError(usage);
    }

    return usage;
  }

  /**
   * Read the current day's usage for a supplier without consuming a booking.
   * Returns `null` when Redis is unavailable.
   */
  async getUsage(supplierId: string): Promise<BookingCapUsage | null> {
    if (typeof supplierId !== "string" || supplierId.trim().length === 0) {
      return null;
    }

    const redis = this.getRedis();
    if (!redis) {
      return null;
    }

    try {
      const raw = await redis.get(supplierDailyCapKey(supplierId, utcDateKey(new Date(this.nowIso()))));
      const used = raw === null ? 0 : parseInt(raw, 10) || 0;
      return {
        supplierId,
        used,
        cap: this.resolveCap(supplierId),
        resetAt: computeBookingCapReset(new Date(this.nowIso())),
      };
    } catch (error) {
      logger.error(
        { err: error, supplierId },
        "supplier-booking-cap: redis error reading usage",
      );
      return null;
    }
  }

  // ─── Admin overrides ───────────────────────────────────────────────────────

  getOverride(supplierId: string): SupplierBookingCapOverride | undefined {
    const override = this.overrides.get(supplierId);
    return override ? { ...override } : undefined;
  }

  listOverrides(): SupplierBookingCapOverride[] {
    return Array.from(this.overrides.values())
      .map((o) => ({ ...o }))
      .sort((a, b) => a.supplierId.localeCompare(b.supplierId));
  }

  async setOverride(
    supplierId: string,
    dailyCap: number,
    changedBy: string,
    description?: string,
  ): Promise<SupplierBookingCapOverride> {
    if (typeof supplierId !== "string" || supplierId.trim().length === 0) {
      throw new Error("supplierId must be a non-empty string");
    }
    if (!Number.isInteger(dailyCap) || dailyCap < 0 || dailyCap > MAX_SUPPLIER_DAILY_BOOKING_CAP) {
      throw new Error(
        `dailyCap must be an integer between 0 and ${MAX_SUPPLIER_DAILY_BOOKING_CAP}`,
      );
    }

    const now = this.nowIso();
    const existing = this.overrides.get(supplierId);
    const override: SupplierBookingCapOverride = {
      supplierId,
      dailyCap,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      createdBy: existing?.createdBy ?? changedBy,
      updatedBy: changedBy,
      description: description ?? existing?.description,
    };
    this.overrides.set(supplierId, override);

    await this.auditLogger.log(
      existing ? "booking_cap.supplier_override_updated" : "booking_cap.supplier_override_created",
      {
        context: {
          supplierId,
          dailyCap,
          previousCap: existing?.dailyCap,
          description,
        },
        userId: changedBy,
      },
      {
        resource: `supplier-booking-cap:${supplierId}`,
        status: 200,
      },
    );

    return { ...override };
  }

  async deleteOverride(supplierId: string, changedBy: string): Promise<boolean> {
    const existing = this.overrides.get(supplierId);
    if (!existing) {
      return false;
    }

    this.overrides.delete(supplierId);

    await this.auditLogger.log(
      "booking_cap.supplier_override_deleted",
      {
        context: { supplierId, previousCap: existing.dailyCap },
        userId: changedBy,
      },
      {
        resource: `supplier-booking-cap:${supplierId}`,
        status: 200,
      },
    );

    return true;
  }

  /** Clear all overrides — used by tests. */
  reset(): void {
    this.overrides.clear();
  }
}

/** Default process-wide singleton. */
export const defaultSupplierBookingCapService = new SupplierBookingCapService();
