/**
 * Per-route request payload size limits middleware.
 *
 * Enforces route-specific size limits even when a global JSON parser has
 * already parsed the request body.
 *
 * Usage
 * ─────
 * // Apply a tight limit to a specific route:
 * router.post("/sessions", payloadLimit("16kb"), handler);
 *
 * // The global default (100kb) is set in app.ts via express.json({ limit }).
 * // Per-route limits override it for sensitive endpoints.
 *
 * Security notes
 * ──────────────
 * - The global body parser caps allocation; route limits are checked before
 *   the route's application logic runs.
 * - The 413 response uses the standard error envelope so clients get a
 *   consistent shape.
 * - Limits are expressed as human-readable strings ("16kb", "1mb") and
 *   validated at startup to catch misconfiguration early.
 */

import express, { Request, Response, NextFunction, RequestHandler } from "express";
import { AppError } from "../errors/AppError.js";

/** Supported size string format: a positive integer followed by kb or mb. */
const SIZE_PATTERN = /^\d+(?:kb|mb|b)$/i;

/**
 * Validate that a size string is well-formed.
 * Throws at module load time if a hard-coded limit is invalid.
 */
function assertValidSizeString(size: string): void {
  if (!SIZE_PATTERN.test(size.trim())) {
    throw new Error(
      `payloadLimit: invalid size string "${size}". ` +
        `Expected format: <number>(b|kb|mb), e.g. "16kb", "1mb".`,
    );
  }
}

function sizeInBytes(size: string): number {
  const match = /^(\d+)(b|kb|mb)$/i.exec(size.trim());
  if (!match) {
    throw new Error(`payloadLimit: invalid size string "${size}"`);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return amount * (unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1);
}

function payloadTooLargeError(limit: string): AppError {
  return new AppError(
    `Request body exceeds the ${limit} limit for this endpoint.`,
    413,
    "PAYLOAD_TOO_LARGE",
    true,
  );
}

/**
 * Return an Express middleware stack that:
 * 1. Checks the captured raw body against the route limit, even if a global
 *    JSON parser has already populated req.body; otherwise parses with limit.
 * 2. Returns a 413 with the standard error envelope when the limit is exceeded.
 *
 * @param limit - Size string accepted by the `bytes` package, e.g. "16kb".
 */
export function payloadLimit(limit: string): RequestHandler[] {
  assertValidSizeString(limit);

  const jsonParser = express.json({ limit });
  const maxBytes = sizeInBytes(limit);

  // Wrap the parser so we can intercept the 413 it emits and normalise it.
  const middleware: RequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (rawBody && rawBody.length > maxBytes) {
      next(payloadTooLargeError(limit));
      return;
    }

    jsonParser(req, res, (err: unknown) => {
      if (err) {
        const status =
          typeof (err as { status?: number }).status === "number"
            ? (err as { status: number }).status
            : 400;

        if (status === 413) {
          next(payloadTooLargeError(limit));
          return;
        }

        // Propagate other parser errors (malformed JSON, etc.)
        next(err);
        return;
      }

      next();
    });
  };

  return [middleware];
}

/**
 * Route-level limits registry.
 *
 * Centralises the per-route limit values so they are easy to audit and
 * adjust without hunting through route files.
 */
export const ROUTE_PAYLOAD_LIMITS = {
  /** Checkout session creation — tight limit to reduce attack surface. */
  checkout: "16kb",
  /** Slot creation — moderate limit. */
  slots: "32kb",
  /** Booking intent creation — tight limit for tiny payloads. */
  bookingIntent: "16kb",
  /** Default for all other routes (matches the global express.json limit). */
  default: "100kb",
} as const;
