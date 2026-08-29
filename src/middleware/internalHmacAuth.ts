import { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookHmacVerified, fairQueueBypassAttempts } from "../metrics.js";
import { configService } from "../config/config.service.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SIGNATURE_HEADER = "x-webhook-signature";
const HMAC_ALGORITHM = "sha256";
// eslint-disable-next-line unused-imports/no-unused-vars
const STALE_PAYLOAD_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
// eslint-disable-next-line unused-imports/no-unused-vars
const CLOCK_SKEW_MS = 60 * 1000; // 1 minute

function isValidHex(signature: string) {
  return /^[0-9a-fA-F]{64}$/.test(signature);
}

function getSignatureFromHeader(headerValue: string | undefined) {
  if (!headerValue) {
    return undefined;
  }

  const trimmed = headerValue.trim();
  if (trimmed.toLowerCase().startsWith(`${HMAC_ALGORITHM}=`)) {
    return trimmed.slice(HMAC_ALGORITHM.length + 1);
  }

  return trimmed;
}

function compareSignatures(expectedHex: string, actualHex: string) {
  if (!isValidHex(expectedHex) || !isValidHex(actualHex)) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedHex, "hex");
  const actualBuffer = Buffer.from(actualHex, "hex");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function internalHmacAuth(expectedSecret?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const currentSecret = expectedSecret ?? process.env.SETTLEMENTS_WEBHOOK_SECRET;
    const previousSecret = process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS;

    if (!currentSecret) {
      return res.status(500).json({
        success: false,
        error: "Settlement webhook signing secret is not configured.",
      });
    }

    const signatureHeader = req.header(SIGNATURE_HEADER);
    const providedSignature = getSignatureFromHeader(signatureHeader);

    if (!providedSignature) {
      webhookHmacVerified.labels("missing").inc();
      return res.status(401).json({
        success: false,
        error: "Missing webhook signature.",
      });
    }

    const rawBody = req.rawBody ?? Buffer.from("");

    const computeHex = (secret: string) =>
      createHmac(HMAC_ALGORITHM, secret).update(rawBody).digest("hex");

    const currentHex = computeHex(currentSecret);
    if (compareSignatures(providedSignature, currentHex)) {
      webhookHmacVerified.labels("current").inc();
      return next();
    }

    if (previousSecret) {
      const prevHex = computeHex(previousSecret);
      if (compareSignatures(providedSignature, prevHex)) {
        webhookHmacVerified.labels("previous").inc();
        return next();
      }
    }

    webhookHmacVerified.labels("invalid").inc();
    return res.status(403).json({
      success: false,
      error: "Invalid webhook signature.",
    });
  };
}

// ---------------------------------------------------------------------------
// Internal fair-queue rate-limit bypass middleware
// ---------------------------------------------------------------------------

/**
 * Header names used by the internal bypass protocol.
 *
 * Callers must send all three headers:
 *
 *   x-bypass-actor   — service / actor ID (e.g. "payout-worker")
 *   x-bypass-ts      — current Unix timestamp in **seconds** (integer string)
 *   x-bypass-sig     — HMAC-SHA256 signature in "sha256=<hex>" format
 *
 * The signed message is:
 *
 *   `${actorId}\n${route}\n${timestamp}`
 *
 * where `route` is `req.path` (e.g. "/api/v1/slots").
 *
 * The secret is read from INTERNAL_OVERRIDE_SECRET (current) and
 * INTERNAL_OVERRIDE_SECRET_PREV (previous, for zero-downtime rotation).
 *
 * If the timestamp is outside the configured tolerance window
 * (INTERNAL_BYPASS_TOLERANCE_MS, default 30 000 ms), the request is rejected
 * as expired.  The signature check is performed with `timingSafeEqual` to
 * prevent timing attacks.
 *
 * When valid, the middleware sets `req.internalBypassActor` to the actor ID
 * and calls `next()`.  The `createAuthAwareRateLimiter` skip function then
 * detects this and skips rate limiting for the request.
 *
 * When the bypass headers are absent the middleware silently calls `next()`,
 * leaving rate limiting unaffected — this keeps the middleware safe to mount
 * globally without requiring every request to present bypass credentials.
 *
 * When the headers are present but invalid (expired, wrong route, bad sig) the
 * middleware returns 401 / 403 to prevent accidental bypass by malformed
 * headers.
 */
export function fairQueueBypass(
  secretOverride?: string,
  prevSecretOverride?: string,
  toleranceMsOverride?: number,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const actor = req.header("x-bypass-actor");
    const tsHeader = req.header("x-bypass-ts");
    const sigHeader = req.header("x-bypass-sig");

    // If none of the bypass headers are present, pass through silently.
    if (!actor && !tsHeader && !sigHeader) {
      fairQueueBypassAttempts.labels("missing").inc();
      return next();
    }

    // All three headers must be present; if only some are supplied treat it as
    // a bad request rather than silently ignoring it.
    if (!actor || !tsHeader || !sigHeader) {
      fairQueueBypassAttempts.labels("bad_format").inc();
      return res.status(401).json({
        success: false,
        error: "Incomplete internal bypass headers.",
      });
    }

    // Validate actor ID: printable ASCII, no whitespace, 1–128 chars.
    if (!/^[\x21-\x7E]{1,128}$/.test(actor)) {
      fairQueueBypassAttempts.labels("bad_format").inc();
      return res.status(401).json({
        success: false,
        error: "Invalid x-bypass-actor value.",
      });
    }

    // Parse timestamp (must be a plain integer string).
    const tsNum = parseInt(tsHeader.trim(), 10);
    if (isNaN(tsNum) || String(tsNum) !== tsHeader.trim()) {
      fairQueueBypassAttempts.labels("bad_format").inc();
      return res.status(401).json({
        success: false,
        error: "Invalid x-bypass-ts value.",
      });
    }

    // Check timestamp tolerance (seconds → ms comparison).
    const toleranceMs = toleranceMsOverride ?? configService.internalBypassToleranceMs;
    const nowMs = Date.now();
    const tsMs = tsNum * 1000;
    if (Math.abs(nowMs - tsMs) > toleranceMs) {
      fairQueueBypassAttempts.labels("expired").inc();
      return res.status(403).json({
        success: false,
        error: "Internal bypass signature has expired.",
      });
    }

    // Extract the hex signature (optional "sha256=" prefix).
    const providedSig = getSignatureFromHeader(sigHeader);
    if (!providedSig || !isValidHex(providedSig)) {
      fairQueueBypassAttempts.labels("bad_format").inc();
      return res.status(401).json({
        success: false,
        error: "Invalid x-bypass-sig format.",
      });
    }

    // Build the canonical signed message.
    const route = req.path;
    const message = `${actor}\n${route}\n${tsNum}`;

    // Resolve active and previous secrets from config (or test overrides).
    const currentSecret =
      secretOverride ?? configService.internalOverrideSecret ?? process.env.INTERNAL_OVERRIDE_SECRET;
    const previousSecret =
      prevSecretOverride ?? configService.internalOverrideSecretPrev ?? process.env.INTERNAL_OVERRIDE_SECRET_PREV;

    if (!currentSecret) {
      // No secret configured — bypass is disabled, reject any attempt.
      fairQueueBypassAttempts.labels("invalid_sig").inc();
      return res.status(403).json({
        success: false,
        error: "Internal bypass is not configured.",
      });
    }

    const computeBypassHex = (secret: string) =>
      createHmac(HMAC_ALGORITHM, secret).update(message).digest("hex");

    // Try current secret first.
    const currentHex = computeBypassHex(currentSecret);
    if (compareSignatures(providedSig, currentHex)) {
      fairQueueBypassAttempts.labels("valid").inc();
      req.internalBypassActor = actor;
      logger.info({ actor, route, ts: tsNum }, "fairQueueBypass: bypass granted");
      return next();
    }

    // Try previous secret for zero-downtime rotation.
    if (previousSecret) {
      const prevHex = computeBypassHex(previousSecret);
      if (compareSignatures(providedSig, prevHex)) {
        fairQueueBypassAttempts.labels("valid").inc();
        req.internalBypassActor = actor;
        logger.info({ actor, route, ts: tsNum }, "fairQueueBypass: bypass granted (prev secret)");
        return next();
      }
    }

    fairQueueBypassAttempts.labels("invalid_sig").inc();
    return res.status(403).json({
      success: false,
      error: "Invalid internal bypass signature.",
    });
  };
}
