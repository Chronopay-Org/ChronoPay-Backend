/**
 * Header Validation Rules — ChronoPay API
 *
 * Provides reusable validators for key HTTP headers:
 *   - Idempotency-Key
 *   - X-Request-Id
 *   - Webhook signature headers (X-Webhook-Signature, X-Hub-Signature-256)
 *
 * Design goals:
 *   - Prevent overlong header abuse (header-size DoS / log injection)
 *   - Reject injection-like characters (control chars, CRLF, null bytes)
 *   - Be self-contained: no external dependencies, pure functions only
 *   - Return structured validation results so callers can compose behaviour
 */

import { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum byte-length for Idempotency-Key values.
 * RFC-9110 recommends keeping header values under 8 KB; we enforce a tighter
 * limit because idempotency keys are always short identifiers.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * Maximum byte-length for X-Request-Id values.
 * UUIDs (36 chars) + common prefixes still fit well under 128 chars.
 */
export const REQUEST_ID_MAX_LENGTH = 128;

/**
 * Maximum byte-length for webhook signature header values.
 * SHA-256 HMAC hex digest = 64 chars; allow generous room for prefix + padding.
 */
export const WEBHOOK_SIGNATURE_MAX_LENGTH = 512;

/**
 * Allowed character set for Idempotency-Key:
 *   Alphanumerics, hyphens, underscores, and dots.
 *   This is a strict allow-list — no whitespace, no control chars, no special
 *   punctuation that could be exploited in log injection or Redis key collisions.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9\-_.]{1,255}$/;

/**
 * Allowed character set for X-Request-Id:
 *   Alphanumerics, hyphens, underscores, plus colon and dot for namespacing.
 */
export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9\-_.:]{1,128}$/;

/**
 * Allowed character set for webhook signature headers.
 *   Hex digits only (after optional "sha256=" prefix stripped by the parser),
 *   or the full "sha256=<hex>" form from GitHub-style HMAC headers.
 */
export const WEBHOOK_SIGNATURE_PATTERN = /^(?:sha256=)?[a-fA-F0-9]{1,512}$/;

// ---------------------------------------------------------------------------
// Core validation result type
// ---------------------------------------------------------------------------

export interface HeaderValidationResult {
  /** true when the value passes all checks */
  valid: boolean;
  /** human-readable reason when valid === false */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Pure validator functions
// ---------------------------------------------------------------------------

/**
 * Validates an Idempotency-Key header value.
 *
 * Rules:
 *   1. Must not be empty or undefined.
 *   2. Must not exceed IDEMPOTENCY_KEY_MAX_LENGTH bytes.
 *   3. Must match IDEMPOTENCY_KEY_PATTERN (alphanumerics, hyphens, underscores, dots).
 *
 * @param value - Raw header string received from the client.
 * @returns Structured validation result.
 */
export function validateIdempotencyKey(
  value: string | undefined,
): HeaderValidationResult {
  if (value === undefined || value === null) {
    return { valid: false, reason: "Idempotency-Key header is missing" };
  }

  if (typeof value !== "string") {
    return { valid: false, reason: "Idempotency-Key must be a string" };
  }

  if (value.length === 0) {
    return { valid: false, reason: "Idempotency-Key must not be empty" };
  }

  if (value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      valid: false,
      reason: `Idempotency-Key exceeds maximum length of ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    };
  }

  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    return {
      valid: false,
      reason:
        "Idempotency-Key contains invalid characters. " +
        "Allowed: alphanumerics, hyphens (-), underscores (_), and dots (.)",
    };
  }

  return { valid: true };
}

/**
 * Validates an X-Request-Id header value.
 *
 * Rules:
 *   1. Must not be empty or undefined.
 *   2. Must not exceed REQUEST_ID_MAX_LENGTH bytes.
 *   3. Must match REQUEST_ID_PATTERN (alphanumerics, hyphens, underscores, colon, dot).
 *
 * @param value - Raw header string received from the client.
 * @returns Structured validation result.
 */
export function validateRequestId(
  value: string | undefined,
): HeaderValidationResult {
  if (value === undefined || value === null) {
    return { valid: false, reason: "X-Request-Id header is missing" };
  }

  if (typeof value !== "string") {
    return { valid: false, reason: "X-Request-Id must be a string" };
  }

  if (value.length === 0) {
    return { valid: false, reason: "X-Request-Id must not be empty" };
  }

  if (value.length > REQUEST_ID_MAX_LENGTH) {
    return {
      valid: false,
      reason: `X-Request-Id exceeds maximum length of ${REQUEST_ID_MAX_LENGTH} characters`,
    };
  }

  if (!REQUEST_ID_PATTERN.test(value)) {
    return {
      valid: false,
      reason:
        "X-Request-Id contains invalid characters. " +
        "Allowed: alphanumerics, hyphens (-), underscores (_), colons (:), and dots (.)",
    };
  }

  return { valid: true };
}

/**
 * Validates a webhook signature header value (X-Webhook-Signature or
 * X-Hub-Signature-256).
 *
 * Rules:
 *   1. Must not be empty or undefined.
 *   2. Must not exceed WEBHOOK_SIGNATURE_MAX_LENGTH bytes.
 *   3. Must match WEBHOOK_SIGNATURE_PATTERN:
 *      - Optional "sha256=" prefix followed by 1–512 hex digits, OR
 *      - 1–512 raw hex digits.
 *
 * @param value - Raw header string received from the client.
 * @returns Structured validation result.
 */
export function validateWebhookSignature(
  value: string | undefined,
): HeaderValidationResult {
  if (value === undefined || value === null) {
    return { valid: false, reason: "Webhook signature header is missing" };
  }

  if (typeof value !== "string") {
    return { valid: false, reason: "Webhook signature must be a string" };
  }

  if (value.length === 0) {
    return { valid: false, reason: "Webhook signature must not be empty" };
  }

  if (value.length > WEBHOOK_SIGNATURE_MAX_LENGTH) {
    return {
      valid: false,
      reason: `Webhook signature exceeds maximum length of ${WEBHOOK_SIGNATURE_MAX_LENGTH} characters`,
    };
  }

  if (!WEBHOOK_SIGNATURE_PATTERN.test(value)) {
    return {
      valid: false,
      reason:
        "Webhook signature contains invalid characters. " +
        'Expected hex digits, optionally prefixed with "sha256="',
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Generic injection guard (shared utility)
// ---------------------------------------------------------------------------

/**
 * Guards against header injection patterns: null bytes, CRLF sequences,
 * and ASCII control characters other than horizontal tab (0x09).
 *
 * This is applied implicitly by the allow-list regexes above, but exposed
 * as a standalone helper for consumers that need to inspect arbitrary headers.
 *
 * @param value - Any string to inspect.
 * @returns true when the value is safe (no injection-like bytes).
 */
export function hasNoInjectionChars(value: string): boolean {
  // Null byte
  if (value.includes("\0")) return false;
  // Carriage return or line feed (CRLF injection)
  if (/[\r\n]/.test(value)) return false;
  // ASCII control characters (0x00–0x08, 0x0B–0x1F, 0x7F) — excludes tab (0x09)
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Express middleware factories
// ---------------------------------------------------------------------------

/**
 * Middleware that enforces strict validation on the Idempotency-Key header
 * when the header is present on the incoming request.
 *
 * Behaviour:
 *   - Header absent → passes through (idempotency is opt-in).
 *   - Header present but invalid → 400 Bad Request with a descriptive message.
 *   - Header present and valid → calls next().
 *
 * Mount this BEFORE idempotencyMiddleware so that malformed keys are rejected
 * before touching Redis.
 */
export function validateIdempotencyKeyHeader(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const rawKey = req.header("Idempotency-Key");

  // Opt-in: no key provided — let idempotencyMiddleware decide
  if (rawKey === undefined) {
    return next();
  }

  const result = validateIdempotencyKey(rawKey);

  if (!result.valid) {
    res.status(400).json({
      success: false,
      error: result.reason,
    });
    return;
  }

  next();
}

/**
 * Middleware that enforces strict validation on the X-Request-Id header
 * when the header is present on the incoming request.
 *
 * Behaviour:
 *   - Header absent → passes through (X-Request-Id is optional; the logger
 *     generates a synthetic ID when absent).
 *   - Header present but invalid → 400 Bad Request with a descriptive message.
 *   - Header present and valid → calls next().
 */
export function validateRequestIdHeader(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const rawId = req.header("X-Request-Id");

  // Optional header — only validate when supplied
  if (rawId === undefined) {
    return next();
  }

  const result = validateRequestId(rawId);

  if (!result.valid) {
    res.status(400).json({
      success: false,
      error: result.reason,
    });
    return;
  }

  next();
}

/**
 * Middleware factory that enforces strict validation on a webhook signature
 * header.
 *
 * @param headerName - The exact header name to inspect, e.g.
 *                     "X-Webhook-Signature" or "X-Hub-Signature-256".
 *                     Defaults to "X-Webhook-Signature".
 *
 * Behaviour:
 *   - Header absent → 400 Bad Request (signature is mandatory on webhook routes).
 *   - Header present but invalid → 400 Bad Request.
 *   - Header present and valid → calls next().
 */
export function validateWebhookSignatureHeader(
  headerName = "X-Webhook-Signature",
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawSig = req.header(headerName);

    const result = validateWebhookSignature(rawSig);

    if (!result.valid) {
      res.status(400).json({
        success: false,
        error: result.reason,
      });
      return;
    }

    next();
  };
}
