/**
 * quotaEnforcement.ts
 *
 * Middleware that enforces daily / monthly API quotas for partner tokens.
 *
 * Place AFTER apiKeyAuth or any auth middleware that populates req.apiKeyId.
 * On each request, the middleware calls checkAndConsume() which:
 *   1. Lazily resets counters if the reset window has passed.
 *   2. Checks whether the token has exceeded its daily or monthly limit.
 *   3. If exceeded, returns 429 Too Many Requests.
 *   4. If approaching the limit (>= 80 %), emits a Prometheus alarm (once per window).
 *   5. Increments the counter.
 */

import type { Request, Response, NextFunction } from "express";
import {
  checkAndConsume,
  SqlQuotaStore,
  type QuotaStore,
} from "../services/partnerQuotaService.js";
import { getPool } from "../db/connection.js";
import { logger } from "../utils/logger.js";
import { configService } from "../config/config.service.js";
import { partnerQuotaCheckFailures } from "../metrics.js";

const QUOTA_RETRY_AFTER_SECONDS = 30;

export type QuotaStoreFactory = () => QuotaStore;

let storeFactory: QuotaStoreFactory = () => new SqlQuotaStore(getPool());
let store: QuotaStore | null = null;

/** Returns the process-wide quota store, creating it on first use. */
function getStore(): QuotaStore {
  if (!store) {
    store = storeFactory();
  }
  return store;
}

/** Test hook: replace the store factory and discard the cached store. */
export function setQuotaStoreFactory(factory: QuotaStoreFactory): void {
  storeFactory = factory;
  store = null;
}

export async function enforceQuota(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tokenId = req.apiKeyId;

  // If no API key context, skip quota enforcement silently
  // (JWT-authenticated routes have separate rate limiting).
  if (!tokenId) {
    next();
    return;
  }

  try {
    const result = await checkAndConsume(tokenId, getStore());

    if (!result.allowed) {
      const limitType = result.exceeded === "daily" ? "daily" : "monthly";
      res.status(429).json({
        success: false,
        error: `Quota exceeded: ${limitType} limit reached.`,
        data: {
          dailyUsed: result.status.dailyUsed,
          dailyLimit: result.status.dailyLimit,
          monthlyUsed: result.status.monthlyUsed,
          monthlyLimit: result.status.monthlyLimit,
          dailyResetAt: result.status.dailyResetAt,
          monthlyResetAt: result.status.monthlyResetAt,
        },
      });
      return;
    }

    // Attach quota headers for visibility
    res.setHeader("X-Quota-Daily-Limit", String(result.status.dailyLimit));
    res.setHeader("X-Quota-Daily-Used", String(result.status.dailyUsed));
    res.setHeader("X-Quota-Monthly-Limit", String(result.status.monthlyLimit));
    res.setHeader("X-Quota-Monthly-Used", String(result.status.monthlyUsed));

    next();
  } catch (err) {
    const mode = configService.quotaFailMode;
    partnerQuotaCheckFailures.labels(mode).inc();
    logger.error({ err }, "quota check failed; allowing request");
    if (mode === "closed") {
      res.setHeader("Retry-After", String(QUOTA_RETRY_AFTER_SECONDS));
      res.status(503).json({
        success: false,
        code: "DEPENDENCY_UNAVAILABLE",
        error: "Partner quota service is currently unavailable",
      });
      return;
    }

    next();
  }
}
