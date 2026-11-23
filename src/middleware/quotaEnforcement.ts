// @ts-nocheck
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

import { Request, Response, NextFunction } from "express";
import { checkAndConsume, SqlQuotaStore } from "../services/partnerQuotaService.js";
import { getPool } from "../db/connection.js";
import { logger } from "../utils/logger.js";
import { configService } from "../config/config.service.js";
import { partnerQuotaCheckFailures } from "../metrics.js";

const QUOTA_RETRY_AFTER_SECONDS = 30;

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
    const pool = getPool();
    const store = new SqlQuotaStore(pool);
    const result = await checkAndConsume(tokenId, store);

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
    logger.error("[quota-enforcement] Failed to check quota:", err instanceof Error ? err.message : String(err));
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
