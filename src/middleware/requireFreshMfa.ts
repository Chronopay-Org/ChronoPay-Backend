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

export function requireFreshMfa(options: RequireFreshMfaOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers["x-chronopay-mfa"];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const token = typeof header === "string" ? header.trim() : "";

    if (token.length === 0) {
      return res.status(401).json({ success: false, error: "Missing MFA challenge" });
    }

    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication required" });
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
      next();
    } catch (error) {
      if (error instanceof MfaConfigurationError) {
        return res.status(500).json({ success: false, error: "MFA is not configured" });
      }
      if (error instanceof MfaChallengeExpiredError) {
        return res.status(401).json({ success: false, error: "MFA challenge has expired; please verify again" });
      }
      if (error instanceof MfaChallengeInvalidError) {
        return res.status(403).json({ success: false, error: "Invalid MFA challenge" });
      }
      return res.status(500).json({ success: false, error: "Failed to verify MFA challenge" });
    }
  };
}