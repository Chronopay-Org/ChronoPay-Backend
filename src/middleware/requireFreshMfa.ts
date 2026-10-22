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

/** Result of {@link verifyRequestMfaChallenge}: ok, or the response to send. */
export type MfaChallengeCheck =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Verifies the `x-chronopay-mfa` header of `req` against the MFA challenge
 * signer, bound to the authenticated actor. Shared by the {@link requireFreshMfa}
 * middleware and the anti-fraud step-up flow (issue #1345), which needs the
 * same verification without owning the response.
 */
export async function verifyRequestMfaChallenge(
  req: Request,
  options: RequireFreshMfaOptions = {},
): Promise<MfaChallengeCheck> {
  const raw = req.headers["x-chronopay-mfa"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const token = typeof header === "string" ? header.trim() : "";

  if (token.length === 0) {
    return { ok: false, status: 401, error: "Missing MFA challenge" };
  }

  const userId = req.auth?.userId;
  if (!userId) {
    return { ok: false, status: 401, error: "Authentication required" };
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
    return { ok: true };
  } catch (error) {
    if (error instanceof MfaConfigurationError) {
      return { ok: false, status: 500, error: "MFA is not configured" };
    }
    if (error instanceof MfaChallengeExpiredError) {
      return {
        ok: false,
        status: 401,
        error: "MFA challenge has expired; please verify again",
      };
    }
    if (error instanceof MfaChallengeInvalidError) {
      return { ok: false, status: 403, error: "Invalid MFA challenge" };
    }
    return { ok: false, status: 500, error: "Failed to verify MFA challenge" };
  }
}

export function requireFreshMfa(options: RequireFreshMfaOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const outcome = await verifyRequestMfaChallenge(req, options);
    if (!outcome.ok) {
      return res.status(outcome.status).json({ success: false, error: outcome.error });
    }
    next();
  };
}