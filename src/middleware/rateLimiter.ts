import rateLimit, {
  type Options,
  type RateLimitRequestHandler,
} from "express-rate-limit";
import { type Request, type Response } from "express";
import { configService } from "../config/config.service.js";
import { RateLimitError } from "../errors/AppError.js";
import { sendErrorResponse } from "../errors/sendError.js";

/**
 * Creates a rate limiter middleware with configurable window and request ceiling.
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
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      sendErrorResponse(res, new RateLimitError(), req);
    },
  };

  return rateLimit(options);
}

const rateLimiter = createRateLimiter();
export default rateLimiter;
