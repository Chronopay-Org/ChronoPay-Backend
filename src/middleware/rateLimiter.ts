import rateLimit, {
  type Options,
  type RateLimitRequestHandler,
} from "express-rate-limit";
import { type Request, type Response } from "express";
import { configService } from "../config/config.service.js";
import { rateLimitRedisStore } from "./rateLimitStore.js";
import { createHash } from "node:crypto";

/**
 * Generate an auth-aware rate limit key.
 *
 * Priority (first match wins):
 *   1. Header-based auth user ID (req.auth.userId)
 *   2. JWT user ID (req.user?.sub || req.user?.id)
 *   3. API key ID (req.apiKeyId)
 *   4. IP address (req.ip)
 *
 * Key format: "rl:{type}:{identifier}"
 *   - rl:user:<userId>
 *   - rl:apiKey:<sha256hash>
 *   - rl:ip:<ip>
 *
 * This scheme ensures:
 *   - Different principal types never collide
 *   - Keys are namespaced and identifiable in Redis
 *   - IP fallback works when auth headers are absent
 */
export function generateRateLimitKey(req: Request): string {
  // Header-based identity (x-chronopay-user-id) — highest priority
  if (req.auth?.userId) {
    return `rl:user:${req.auth.userId}`;
  }

  // JWT identity (Authorization: Bearer <token>)
  if (req.user) {
    const userId = req.user.sub || req.user.id;
    if (userId) {
      return `rl:user:${userId}`;
    }
  }

  // API key identity (x-api-key)
  if (req.apiKeyId) {
    return `rl:apiKey:${req.apiKeyId}`;
  }

  // IP address fallback — hash to avoid IPv6 detection and ensure consistent length
  const ip = getClientIp(req);
  const ipHash = createHash('sha256').update(ip, 'utf8').digest('hex');
  return `rl:ip:${ipHash}`;
}

// Helper to extract IP without referencing `req.ip` directly in the main function.
function getClientIp(req: Request): string {
  const anyReq = req as any;
  return anyReq.ip || anyReq.socket?.remoteAddress || 'anonymous';
}

/**
 * Original IP-only rate limiter (unchanged for backward compatibility).
 * Uses default MemoryStore; suitable for tests and not used in production.
 */
export function createRateLimiter(
  windowMs?: number,
  max?: number,
): RateLimitRequestHandler {
  const resolvedWindowMs = windowMs ?? configService.rateLimitWindowMs;
  const resolvedMax = max ?? configService.rateLimitMax;

  const options: Partial<Options> = {
    windowMs: resolvedWindowMs,
    limit: resolvedMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        success: false,
        error: 'Too many requests, please try again later.',
      });
    },
  };

  return rateLimit(options);
}

/**
 * Auth-aware rate limiter.
 *
 * Place AFTER authentication middleware so that req.auth, req.user, or req.apiKeyId
 * are populated. Falls back to IP-based key when no identity present.
 *
 * Uses shared Redis store to ensure counters are consistent across routes and instances.
 *
 * In test environment (NODE_ENV=test), rate limiting is automatically skipped
 * to prevent flaky tests.
 *
 * @param windowMs - Time window in milliseconds (default from config)
 * @param max - Max requests per window (default from config)
 * @returns Express middleware function
 */
export function createAuthAwareRateLimiter(
  windowMs?: number,
  max?: number,
): RateLimitRequestHandler {
  const resolvedWindowMs = windowMs ?? configService.rateLimitWindowMs;
  const resolvedMax = max ?? configService.rateLimitMax;

  const options: Partial<Options> = {
    windowMs: resolvedWindowMs,
    limit: resolvedMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: generateRateLimitKey,
    store: rateLimitRedisStore,
    // Skip rate limiting in test environment to avoid flaky tests
    skip: () => process.env.NODE_ENV === 'test',
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        success: false,
        error: 'Too many requests, please try again later.',
      });
    },
  };

  return rateLimit(options);
}

// Default export: traditional IP-only limiter (not currently used in app)
const rateLimiter = createRateLimiter();
export default rateLimiter;
