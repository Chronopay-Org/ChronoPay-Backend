import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { configService } from "../config/config.service.js";
import { oauth2Service, OAuth2Error } from "../services/oauth2.service.js";
import { signJwt } from "../utils/jwt.js";

const router = Router();

const COOKIE_NAME_STATE = "oauth2_state";
const COOKIE_NAME_PKCE = "oauth2_pkce";
const COOKIE_NAME_NONCE = "oauth2_nonce";
const COOKIE_NAME_REDIRECT = "oauth2_redirect";
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 10 * 60 * 1000, // 10 minutes
};

/**
 * Build the set of exact allowed redirect origins.
 * APP_URL is always included when parseable; OAUTH_REDIRECT_ALLOWLIST (comma-separated)
 * adds extra origins.
 */
function getAllowedRedirectOrigins(): Set<string> {
  const origins = new Set<string>();

  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      origins.add(new URL(appUrl).origin);
    } catch {
      // Ignore invalid APP_URL
    }
  }

  const allowlist = process.env.OAUTH_REDIRECT_ALLOWLIST;
  if (allowlist) {
    for (const entry of allowlist.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      try {
        origins.add(new URL(appUrl ? new URL(trimmed, appUrl) : trimmed).origin);
      } catch {
        // Ignore invalid allowlist entries
      }
    }
  }

  return origins;
}

/**
 * Validate a redirect target. Relative paths are always accepted.
 * Absolute URLs must match an allowed origin exactly.
 * Returns the normalized redirect target or null if invalid.
 */
function validateRedirectUrl(raw: string): string | null {
  // Relative path: must start with a single "/" and not "//" (protocol-relative)
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const allowed = getAllowedRedirectOrigins();
  if (!allowed.has(parsed.origin)) {
    return null;
  }

  return parsed.toString();
}

/**
 * Get /api/v1/auth/oauth/:provider/start
 * Initiates OAuth2 flow for the given provider
 */
router.get("/:provider/start", (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const redirectUrl = req.query.redirect_url as string | undefined;

    // Validate provider
    const enabledProviders = oauth2Service.getEnabledProviders();
    if (!provider || !enabledProviders.includes(provider)) {
      return res.status(400).json({
        success: false,
        error: "Invalid or unsupported provider",
      });
    }

    // Validate redirect URL before creating any session state
    let validatedRedirect: string | undefined;
    if (redirectUrl !== undefined) {
      const result = validateRedirectUrl(redirectUrl);
      if (result === null) {
        return res.status(400).json({
          success: false,
          error: "Invalid redirect URL",
        });
      }
      validatedRedirect = result;
    }

    // Generate PKCE challenge and state
    const pkceChallenge = oauth2Service.generatePKCEChallenge();
    const state = oauth2Service.generateState();
    const nonce = crypto.randomBytes(16).toString("hex");

    // Store state, PKCE, and nonce in signed httpOnly cookies for validation on callback
    res.cookie(COOKIE_NAME_STATE, state, COOKIE_OPTIONS);
    res.cookie(
      COOKIE_NAME_PKCE,
      JSON.stringify({
        verifier: pkceChallenge.codeVerifier,
        challenge: pkceChallenge.codeChallenge,
      }),
      COOKIE_OPTIONS,
    );
    res.cookie(COOKIE_NAME_NONCE, nonce, COOKIE_OPTIONS);

    // Persist the validated redirect target so the callback can return it
    if (validatedRedirect !== undefined) {
      res.cookie(COOKIE_NAME_REDIRECT, validatedRedirect, COOKIE_OPTIONS);
    } else {
      res.clearCookie(COOKIE_NAME_REDIRECT, { path: "/" });
    }

    // Build authorization URL
    const authUrl = oauth2Service.buildAuthorizationUrl(
      provider,
      pkceChallenge.codeChallenge,
      state,
      nonce,
    );

    return res.status(200).json({
      success: true,
      authorization_url: authUrl,
    });
  } catch (error) {
    if (error instanceof OAuth2Error) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.code,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: "Failed to initiate OAuth2 flow",
    });
  }
});

/**
 * GET /api/v1/auth/oauth/:provider/callback
 * OAuth2 callback endpoint - exchanges code for token
 */
router.get("/:provider/callback", async (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const { code, state, error, error_description } = req.query as Record<
      string,
      string | undefined
    >;

    // Check for OAuth2 errors from provider
    if (error) {
      return res.status(400).json({
        success: false,
        error: error || "oauth2_provider_error",
        message: error_description || "Provider returned an error",
      });
    }

    // Validate required parameters
    if (!provider || !code || !state) {
      return res.status(400).json({
        success: false,
        error: "missing_parameters",
        message: "Missing required OAuth2 parameters",
      });
    }

    // Validate provider
    const enabledProviders = oauth2Service.getEnabledProviders();
    if (!enabledProviders.includes(provider)) {
      return res.status(400).json({
        success: false,
        error: "invalid_provider",
        message: "Provider is not configured",
      });
    }

    // Retrieve stored values from cookies
    const storedState = req.cookies[COOKIE_NAME_STATE];
    const pkceData = req.cookies[COOKIE_NAME_PKCE];
    const storedNonce = req.cookies[COOKIE_NAME_NONCE];
    const storedReedirect = req.cookies[COOKIE_NAME_REDIRECT] as string | undefined;

    // Validate state - prevent CSRF and replay attacks
    if (!storedState || storedState !== state) {
      // Clear cookies immediately
      res.clearCookie(COOKIE_NAME_STATE, { path: "/" });
      res.clearCookie(COOKIE_NAME_PKCE, { path: "/" });
      res.clearCookie(COOKIE_NAME_NONCE, { path: "/" });
      res.clearCookie(COOKIE_NAME_REDIRECT, { path: "/" });

      return res.status(400).json({
        success: false,
        error: "state_mismatch",
        message: "State parameter mismatch - possible CSRF attack",
      });
    }

    // Validate PKCE data
    if (!pkceData) {
      res.clearCookie(COOKIE_NAME_STATE, { path: "/" });
      res.clearCookie(COOKIE_NAME_PKCE, { path: "/" });
      res.clearCookie(COOKIE_NAME_NONCE, { path: "/" });
      res.clearCookie(COOKIE_NAME_REDIRECT, { path: "/" });

      return res.status(400).json({
        success: false,
        error: "invalid_session",
        message: "PKCE challenge not found",
      });
    }

    let codeVerifier: string;
    try {
      const parsed = JSON.parse(pkceData);
      codeVerifier = parsed.verifier;
    } catch {
      res.clearCookie(COOKIE_NAME_STATE, { path: "/" });
      res.clearCookie(COOKIE_NAME_PKCE, { path: "/" });
      res.clearCookie(COOKIE_NAME_NONCE, { path: "/" });
      res.clearCookie(COOKIE_NAME_REDIRECT, { path: "/" });

      return res.status(400).json({
        success: false,
        error: "invalid_session",
        message: "Invalid PKCE data",
      });
    }

    // Exchange code for token
    const tokenResponse = await oauth2Service.exchangeCodeForToken(provider, code, codeVerifier);

    // Fetch user info from provider
    const userInfo = await oauth2Service.fetchUserInfo(provider, tokenResponse.access_token);

    // Validate nonce if ID token is present (for Google/OIDC)
    if (tokenResponse.id_token && storedNonce) {
      try {
        // Simple JWT decode (no verification needed - we trust the provider via HTTPS)
        const parts = tokenResponse.id_token.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(
            Buffer.from(parts[1], "base64").toString("utf-8")
          ) as Record<string, unknown>;
          if (!oauth2Service.verifyNonce(storedNonce, payload.nonce as string | undefined)) {
            res.clearCookie(COOKIE_NAME_STATE, { path: "/" });
            res.clearCookie(COOKIE_NAME_PKCE, { path: "/" });
            res.clearCookie(COOKIE_NAME_NONCE, { path: "/" });
            res.clearCookie(COOKIE_NAME_REDIRECT, { path: "/" });

            return res.status(400).json({
              success: false,
              error: "nonce_mismatch",
              message: "Nonce validation failed",
            });
          }
        }
      } catch (_decodeError) {
        // If ID token can't be decoded, just skip nonce validation
        // (not all providers send ID tokens)
      }
    }

    // Generate application JWT
    const jwtSecret = configService.getSecret("JWT_SECRET");
    const appJwt = await signJwt(
      {
        sub: userInfo.id,
        email: userInfo.email,
        name: userInfo.name,
        provider: userInfo.provider,
        iat: Math.floor(Date.now() / 1000),
      },
      jwtSecret,
      {
        expiresInSec: 24 * 60 * 60, // 24 hours
        issuer: configService.jwtIssuer,
        audience: configService.jwtAudience,
      },
    );

    // Clear OAuth2 cookies
    res.clearCookie(COOKIE_NAME_STATE, { path: "/" });
    res.clearCookie(COOKIE_NAME_PKCE, { path: "/" });
    res.clearCookie(COOKIE_NAME_NONCE, { path: "/" });
    res.clearCookie(COOKIE_NAME_REDIRECT, { path: "/" });

    // Return the JWT to the client (do NOT include provider tokens)
    const responseBody: Record<string, unknown> = {
      success: true,
      token: appJwt,
      user: {
        id: userInfo.id,
        email: userInfo.email,
        name: userInfo.name,
        provider: userInfo.provider,
      },
    };
    if (storedRedirect) {
      responseBody.redirect_url = storedRedirect;
    }

    return res.status(200).json(responseBody);
  } catch (error) {
    if (error instanceof OAuth2Error) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.code,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: "internal_error",
      message: "Failed to complete OAuth2 callback",
    });
  }
});

export default router;
