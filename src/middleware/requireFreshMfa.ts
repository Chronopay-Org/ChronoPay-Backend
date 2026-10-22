import type { NextFunction, Request, Response } from "express";
import { mfaService } from "../services/mfaService.js";
import {
  MfaChallengeExpiredError,
  MfaChallengeInvalidError,
  MfaConfigurationError,
} from "../errors/mfaErrors.js";

/**
 * Express middleware that requires a *fresh*, user-bound MFA challenge for the
 * request. It is designed to sit immediately after an auth middleware (JWT or
 * header-based) so `req.auth.userId` is available.
 *
 * The client proves step-up authentication by sending the challenge token
 * issued by `POST /api/v1/auth/mfa/verify` in a dedicated header:
 *
 *   x-chronopay-mfa: <token>
 *
 * A dedicated header (rather than the `Authorization` scheme) keeps this
 * compatible with the `Bearer`-based access JWT and mirrors the existing
 * `x-chronopay-*` internal-auth headers. The token is:
 *  - signed with the dedicated `MFA_CHALLENGE_SECRET`,
 *  - bound to the authenticated user's subject,
 *  - considered valid for at most `maxAgeMs` (freshness), defaulting to the
 *    globally configured `mfaFreshnessMs` (15 minutes).
 *
 * Use it on any high-risk route, e.g.:
 *
 *   router.post("/withdraw", requireAuth(), requireFreshMfa(), handler)
 */

export interface RequireFreshMfaOptions {
  /** Freshness window for the challenge (ms). Defaults to mfaFreshnessMs. */
  maxAgeMs?: number;
  /** Override of the challenge signing secret (normally from config). */
  challengeSecret?: string;
  issuer?: string;
  audience?: string;
  /** Injectable clock for tests. */
  nowMs?: number;
}

/**
 * Verifies the `x-chronopay-mfa` proof on `req` without owning the rest of the
 * request lifecycle. Returns `true` when the proof is valid; on failure it
 * writes the same status/body mapping as {@link requireFreshMfa} and returns
 * `false` so the caller must not continue.
 *
 * Shared by the `requireFreshMfa` middleware and the anti-fraud wall's
 * `x-fraud-challenge` retry path (both must apply identical MFA semantics).
 */
export async function assertFreshMfa(
  req: Request,
  res: Response,
  options: RequireFreshMfaOptions = {},
): Promise<boolean> {
  const raw = req.headers["x-chronopay-mfa"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const token = typeof header === "string" ? header.trim() : "";

  if (token.length === 0) {
    res.status(401).json({ success: false, error: "Missing MFA challenge" });
    return false;
  }

  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ success: false, error: "Authentication required" });
    return false;
  }

  try {
    await mfaService.verifyChallenge(token, {
      expectedUserId: userId,
      challengeSecret: options.challengeSecret,
      issuer: options.issuer,
      audience: options.audience,
      freshnessMs: options.maxAgeMs,
      nowMs: options.nowMs,
    });
    return true;
  } catch (error) {
    if (error instanceof MfaConfigurationError) {
      res.status(500).json({ success: false, error: "MFA is not configured" });
    } else if (error instanceof MfaChallengeExpiredError) {
      res.status(401).json({ success: false, error: "MFA challenge has expired; please verify again" });
    } else if (error instanceof MfaChallengeInvalidError) {
      res.status(403).json({ success: false, error: "Invalid MFA challenge" });
    } else {
      res.status(500).json({ success: false, error: "Failed to verify MFA challenge" });
    }
    return false;
  }
}

export function requireFreshMfa(options: RequireFreshMfaOptions = {}) {
  // Async so callers that `await` the middleware observe `next()` (or the
  // error response) before the returned promise settles — same contract as
  // when this body lived directly inside the factory.
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (await assertFreshMfa(req, res, options)) {
        next();
      }
    } catch {
      // assertFreshMfa maps expected failures itself; this guard only keeps
      // an unexpected throw from surfacing as an unhandled rejection.
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: "Failed to verify MFA challenge" });
      }
    }
    next();
  };
}