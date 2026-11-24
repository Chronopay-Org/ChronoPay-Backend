import { Router, Request, Response } from "express";
import { configService } from "../config/config.service.js";
import { verifyJwt } from "../utils/jwt.js";
import { requireAuth } from "../middleware/auth.js";
import { mfaService } from "../services/mfaService.js";
import { isMfaError } from "../errors/mfaErrors.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

/**
 * @openapi
 * components:
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *       description: JWT access token accepted by authenticated ChronoPay routes.
 *   parameters:
 *     XChronopayMfa:
 *       in: header
 *       name: x-chronopay-mfa
 *       required: true
 *       schema:
 *         type: string
 *       description: >
 *         Fresh MFA challenge token issued by POST /api/v1/auth/mfa/verify.
 *         Send it as `x-chronopay-mfa: <mfaToken>` on routes protected by
 *         `requireFreshMfa`; it is intentionally separate from the Bearer
 *         access token. A missing or expired challenge returns 401, a
 *         challenge bound to a different subject returns 403, and an
 *         unconfigured MFA deployment returns 500.
 *   schemas:
 *     ErrorEnvelope:
 *       type: object
 *       description: >
 *         Flat error envelope produced by AppError.toJSON() in
 *         src/errors/AppError.ts. Auth route handlers emit the `success` and
 *         `error` subset; `code`, `message`, `timestamp`, `requestId` and
 *         `details` are included when an error flows through the shared error
 *         middleware.
 *       required:
 *         - success
 *       properties:
 *         success:
 *           type: boolean
 *           example: false
 *         code:
 *           type: string
 *           description: Machine-readable error code from the shared taxonomy.
 *           example: UNAUTHORIZED
 *         message:
 *           type: string
 *           description: Human-readable error message.
 *           example: Invalid token
 *         error:
 *           type: string
 *           description: Alias of `message` retained for backwards compatibility.
 *           example: Invalid token
 *         timestamp:
 *           type: string
 *           format: date-time
 *           example: "2024-03-15T12:00:00.000Z"
 *         requestId:
 *           type: string
 *           description: Correlation id when available.
 *           example: req_123
 *         details:
 *           description: Optional structured error details.
 */

/**
 * @openapi
 * /api/v1/auth/verify:
 *   post:
 *     tags: [Auth]
 *     summary: Verify a JWT access token
 *     description: >
 *       Verifies a JWT against all active secret versions (current and retired)
 *       and returns the verified subject and expiry. Validation failures are
 *       intentionally generic so token internals are not leaked.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *                 description: Signed JWT access token to verify.
 *           example:
 *             token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImlhdCI6MTcxMDAwMDAwMCwiZXhwIjoxNzEwMDAzNjAwfQ.signature
 *     responses:
 *       200:
 *         description: Token verified successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 subject:
 *                   type: string
 *                   nullable: true
 *                   description: Token subject (`sub`, falling back to `id`), or null when absent.
 *                 expiresAt:
 *                   type: integer
 *                   description: Token expiry (`exp`) as a Unix timestamp in seconds.
 *             example:
 *               success: true
 *               subject: user-123
 *               expiresAt: 1710003600
 *       400:
 *         description: Token is missing or not a string.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: token is required
 *       401:
 *         description: Token is invalid, expired, or signed by an unknown secret.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: Invalid token
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
 * @openapi
 * /api/v1/auth/mfa/enroll:
 *   post:
 *     tags: [Auth]
 *     summary: Enrol the authenticated user for TOTP MFA
 *     description: >
 *       Enrols the authenticated user for TOTP MFA and returns the base32
 *       secret plus an `otpauth://` URI so the client can render a QR code or
 *       let the user enter the key manually. The enrolment only becomes active
 *       once a code is confirmed via POST /api/v1/auth/mfa/verify. Pending
 *       enrolments may be re-enrolled; an already-active enrolment is a
 *       conflict.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Pending MFA enrolment created.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, secret, otpauthUrl, digits, period, algorithm]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 secret:
 *                   type: string
 *                   description: Base32-encoded TOTP secret.
 *                   example: JBSWY3DPEHPK3PXP
 *                 otpauthUrl:
 *                   type: string
 *                   description: Provisioning URI for authenticator apps.
 *                   example: otpauth://totp/ChronoPay:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ChronoPay&digits=6&period=30&algorithm=SHA1
 *                 digits:
 *                   type: integer
 *                   example: 6
 *                 period:
 *                   type: integer
 *                   description: TOTP time step in seconds.
 *                   example: 30
 *                 algorithm:
 *                   type: string
 *                   example: SHA1
 *                 alreadyVerified:
 *                   type: boolean
 *                   example: false
 *             example:
 *               success: true
 *               secret: JBSWY3DPEHPK3PXP
 *               otpauthUrl: otpauth://totp/ChronoPay:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=ChronoPay&digits=6&period=30&algorithm=SHA1
 *               digits: 6
 *               period: 30
 *               algorithm: SHA1
 *               alreadyVerified: false
 *       401:
 *         description: Missing, invalid, or subject-less Bearer access token.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: Missing Authorization header
 *       409:
 *         description: MFA is already active for the account.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: MFA is already enabled for this account
 *       429:
 *         description: Too many MFA requests for this account.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: Too many requests, please try again later.
 *       500:
 *         description: MFA encryption is not configured (for example MFA_ENCRYPTION_KEY is missing).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: "MFA is not configured: MFA_ENCRYPTION_KEY is not provisioned"
 */
router.post(
  "/mfa/enroll",
  requireAuth(),
  createAuthAwareRateLimiter(),
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
 * @openapi
 * /api/v1/auth/mfa/verify:
 *   post:
 *     tags: [Auth]
 *     summary: Verify a TOTP code and issue a fresh MFA challenge
 *     description: >
 *       Validates a TOTP code for the authenticated user and, on success,
 *       returns a short-lived MFA challenge token. Send that token on
 *       step-up routes as `x-chronopay-mfa: <mfaToken>`; `requireFreshMfa`
 *       validates its signature, subject binding, and freshness (default
 *       15 minutes), returning 401 when the challenge is missing or expired
 *       and 403 when it belongs to a different subject. Replay protection
 *       rejects reusing the same time-window code with 409. The reusable
 *       header contract is documented as
 *       `#/components/parameters/XChronopayMfa`.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code:
 *                 type: string
 *                 pattern: '^\d{6,10}$'
 *                 description: Current TOTP code (6-10 digits; surrounding whitespace is trimmed).
 *           example:
 *             code: "123456"
 *     responses:
 *       200:
 *         description: TOTP code accepted; a fresh MFA challenge was issued.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, mfaToken, expiresInSec, freshUntilSec]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 mfaToken:
 *                   type: string
 *                   description: Short-lived challenge token for the x-chronopay-mfa header.
 *                   example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImlhdCI6MTcxMDAwMDAwMCwibWZhX2F0IjoxNzEwMDAwMDAwLCJleHAiOjE3MTAwMDMwMDB9.signature
 *                 expiresInSec:
 *                   type: integer
 *                   description: Challenge token lifetime in seconds.
 *                   example: 300
 *                 freshUntilSec:
 *                   type: integer
 *                   description: Unix timestamp (seconds) after which the challenge is stale.
 *                   example: 1710000900
 *                 alreadyVerified:
 *                   type: boolean
 *                   description: Whether the enrolment was already active before this verification.
 *                   example: true
 *             example:
 *               success: true
 *               mfaToken: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImlhdCI6MTcxMDAwMDAwMCwibWZhX2F0IjoxNzEwMDAwMDAwLCJleHAiOjE3MTAwMDMwMDB9.signature
 *               expiresInSec: 300
 *               freshUntilSec: 1710000900
 *               alreadyVerified: true
 *       400:
 *         description: Code is missing or is not 6-10 digits.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: code must be 6-10 digits
 *       401:
 *         description: Missing/invalid Bearer token, or the TOTP code is invalid or expired.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: Invalid or expired MFA code
 *       404:
 *         description: The account has no MFA enrolment.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: MFA is not enabled for this account
 *       409:
 *         description: The code was already used (replay detected).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: This MFA code was already used
 *       429:
 *         description: Verification is temporarily locked after repeated invalid codes.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: MFA verification is temporarily locked; try again later
 *       500:
 *         description: MFA is not configured (for example MFA_ENCRYPTION_KEY or MFA_CHALLENGE_SECRET is missing).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *             example:
 *               success: false
 *               error: "MFA is not configured: MFA_ENCRYPTION_KEY is not provisioned"
 */
router.post(
  "/mfa/verify",
  requireAuth(),
  createAuthAwareRateLimiter(),
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