/**
 * Per-route request payload size limits middleware.
 *
 * Enforces body size limits before deep JSON parsing so that oversized
 * payloads are rejected at the network layer, not after allocation.
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
 * - Limits are enforced by express's built-in body-parser before any
 *   application logic runs.
 * - The 413 response uses the standard error envelope so clients get a
 *   consistent shape.
 * - Limits are expressed as human-readable strings ("16kb", "1mb") and
 *   validated at startup to catch misconfiguration early.
 */

import express, { Request, Response, NextFunction, RequestHandler } from "express";

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

/**
 * Return an Express middleware stack that:
 * 1. Re-parses the raw body with the given size limit (overriding any global
 *    limit set earlier in the chain).
 * 2. Returns a 413 with the standard error envelope when the limit is exceeded.
 *
 * @param limit - Size string accepted by the `bytes` package, e.g. "16kb".
 */
export function payloadLimit(limit: string): RequestHandler[] {
  assertValidSizeString(limit);

  const jsonParser = express.json({ limit });

  // Wrap the parser so we can intercept the 413 it emits and normalise it.
  const middleware: RequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    jsonParser(req, res, (err: unknown) => {
      if (err) {
        const status =
          typeof (err as { status?: number }).status === "number"
            ? (err as { status: number }).status
            : 400;

        if (status === 413) {
          res.status(413).json({
            success: false,
            code: "PAYLOAD_TOO_LARGE",
            error: `Request body exceeds the ${limit} limit for this endpoint.`,
          });
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
  /** Default for all other routes (matches the global express.json limit). */
  default: "100kb",
} as const;
