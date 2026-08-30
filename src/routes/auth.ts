import { Router, Request, Response } from "express";
import { configService } from "../config/config.service.js";
import { verifyJwt } from "../utils/jwt.js";
import { requireAuth } from "../middleware/auth.js";
import { mfaService } from "../services/mfaService.js";
import { isMfaError } from "../errors/mfaErrors.js";

const router = Router();

/**
 * POST /api/v1/auth/verify
 * Verifies a JWT against all active secret versions and returns the verified claims.
 */
router.post("/verify", async (req: Request, res: Response) => {
  const { token } = req.body ?? {};

  if (!token || typeof token !== "string") {
    return res.status(400).json({ success: false, error: "token is required" });
  }

  try {
    const payload = await verifyJwt(token, { issuer: configService.jwtIssuer ?? undefined });

    return res.status(200).json({
      success: true,
      subject: payload.sub ?? payload.id ?? null,
      expiresAt: payload.exp,
    });
  } catch {
    return res.status(401).json({ success: false, error: "Invalid token" });
  }
});

function respondMfaError(res: Response, error: unknown): Response {
  if (isMfaError(error)) {
    return res.status(error.statusCode).json({ success: false, error: error.message });
  }
  return res.status(500).json({ success: false, error: "Failed to process MFA request" });
}

/**
 * POST /api/v1/auth/mfa/enroll
 * Enrols the authenticated user for TOTP MFA. Returns the base32 secret and an
 * otpauth:// URI so the client can render a QR code (or let the user enter the
 * key manually). The enrolment only becomes active once a code is confirmed
 * via POST /api/v1/auth/mfa/verify.
 *
 * Responses:
 *  - 200 with { success, secret, otpauthUrl, digits, period, algorithm }
 *  - 401 when not authenticated
 *  - 409 when MFA is already active for the account
 *  - 500 when MFA_ENCRYPTION_KEY is not provisioned
 */
router.post(
  "/mfa/enroll",
  requireAuth(),
  async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    try {
      const result = await mfaService.enroll(userId);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      return respondMfaError(res, error);
    }
  },
);

/**
 * POST /api/v1/auth/mfa/verify
 * Validates a TOTP code for the authenticated user and, on success, returns a
 * short-lived MFA challenge token. The token is passed as
 * `x-chronopay-mfa: <token>` to routes protected by `requireFreshMfa`.
 * Replay protection rejects re-using the same time-window code (409).
 *
 * Responses:
 *  - 200 with { success, mfaToken, expiresInSec, freshUntilSec }
 *  - 400 when `code` is missing/malformed
 *  - 401 when the code is invalid or the account has no enrolment
 *  - 409 when the code was already used (replay)
 */
router.post(
  "/mfa/verify",
  requireAuth(),
  async (req: Request, res: Response) => {
    const { code } = req.body ?? {};

    if (typeof code !== "string" || !/^\d{6,10}$/.test(code.trim())) {
      return res.status(400).json({ success: false, error: "code must be 6-10 digits" });
    }

    const userId = req.auth!.userId;
    try {
      const result = await mfaService.verifyCode(userId, code.trim());
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      return respondMfaError(res, error);
    }
  },
);

export default router;