import rateLimit, {
  type Options,
  type RateLimitRequestHandler,
} from "express-rate-limit";
import { type Request, type Response } from "express";

/**
 * Creates a rate limiter middleware with configurable window and request ceiling.
 *
 * Reads configuration from environment variables when no explicit values are
 * provided, then falls back to safe production defaults:
 *   - RATE_LIMIT_WINDOW_MS  (default: 900000 — 15 minutes)
 *   - RATE_LIMIT_MAX        (default: 100 requests per window)
 *
 * Each call creates an independent in-memory store, so multiple instances
 * (e.g., a global limiter and a stricter per-route limiter) do not share state.
 *
 * @param windowMs - Duration of the sliding window in milliseconds.
 * @param max      - Maximum number of requests allowed per window per IP.
 * @returns Configured express-rate-limit middleware instance.
 */
export function createRateLimiter(
  windowMs?: number,
  max?: number,
): RateLimitRequestHandler {
  const resolvedWindowMs =
    windowMs ??
    (parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "", 10) || 15 * 60 * 1000);

  const resolvedMax =
    max ?? (parseInt(process.env.RATE_LIMIT_MAX ?? "", 10) || 100);

  const options: Partial<Options> = {
    windowMs: resolvedWindowMs,
    // `limit` is the v7 name for the max-requests option (`max` is a deprecated alias)
    limit: resolvedMax,
    // Sends a single RFC draft-7 combined `RateLimit` response header
    standardHeaders: "draft-7",
    // Disables the legacy `X-RateLimit-*` headers
    legacyHeaders: false,
    // Override the default plain-text handler to match the project's JSON error envelope
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        success: false,
        error: "Too many requests, please try again later.",
      });
    },
  };

  return rateLimit(options);
}

/**
 * Default global rate limiter.
 *
 * Applied in src/index.ts via `app.use(rateLimiter)` to protect all routes.
 * Configure via RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX environment variables,
 * or override for specific route groups using createRateLimiter().
 */
const rateLimiter = createRateLimiter();
export default rateLimiter;
