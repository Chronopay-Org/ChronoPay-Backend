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
 * Clear every OAuth2 flow cookie. Called on all callback failure paths so a
 * failed login cannot leave a half-used state/PKCE/nonce session behind.
 */
function clearOAuthCookies(res: Response): void {
  res.clearCookie(COOKIE_NAME_STATE, { path: "/" });
  res.clearCookie(COOKIE_NAME_PKCE, { path: "/" });
  res.clearCookie(COOKIE_NAME_NONCE, { path: "/" });
  res.clearCookie(COOKIE_NAME_REDIRECT, { path: "/" });
}

/**
 * Send a callback failure response and clear the OAuth2 cookies. All callback
 * errors go through here so cookie clearing cannot be forgotten.
 */
function failOAuth(
  res: Response,
  statusCode: number,
  error: string,
  message: string,
): Response {
  clearOAuthCookies(res);
  return res.status(statusCode).json({ success: false, error, message });
}

/**
 * GET /api/v1/auth/oauth/:provider/start
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
      return failOAuth(
        res,
        400,
        error || "oauth2_provider_error",
        error_description || "Provider returned an error",
      );
    }

    // Validate required parameters
    if (!provider || !code || !state) {
      return failOAuth(
        res,
        400,
        "missing_parameters",
        "Missing required OAuth2 parameters",
      );
    }

    // Validate provider
    const enabledProviders = oauth2Service.getEnabledProviders();
    if (!enabledProviders.includes(provider)) {
      return failOAuth(res, 400, "invalid_provider", "Provider is not configured");
    }

    // Retrieve stored values from cookies
    const storedState = req.cookies[COOKIE_NAME_STATE];
    const pkceData = req.cookies[COOKIE_NAME_PKCE];
    const storedNonce = req.cookies[COOKIE_NAME_NONCE];
    const storedRedirect = req.cookies[COOKIE_NAME_REDIRECT] as string | undefined;

    // Validate state - prevent CSRF and replay attacks
    if (!storedState || storedState !== state) {
      return failOAuth(
        res,
        400,
        "state_mismatch",
        "State parameter mismatch - possible CSRF attack",
      );
    }

    // Validate PKCE data
    if (!pkceData) {
      return failOAuth(res, 400, "invalid_session", "PKCE challenge not found");
    }

    let codeVerifier: string;
    try {
      const parsed = JSON.parse(pkceData);
      codeVerifier = parsed.verifier;
    } catch {
      return failOAuth(res, 400, "invalid_session", "Invalid PKCE data");
    }

    // Exchange code for token
    const tokenResponse = await oauth2Service.exchangeCodeForToken(provider, code, codeVerifier);

    // OIDC providers (e.g. Google) are requested with the `openid` scope and
    // must return an ID token whose nonce matches the one stored before the
    // redirect. GitHub is plain OAuth2 and does not return an ID token; if one
    // shows up we still validate it rather than trusting it.
    const requiresIdToken = oauth2Service.isOidcProvider(provider);

    if (requiresIdToken && !tokenResponse.id_token) {
      return failOAuth(
        res,
        400,
        "missing_id_token",
        "Provider did not return an ID token",
      );
    }

    if (requiresIdToken && !storedNonce) {
      return failOAuth(
        res,
        400,
        "missing_nonce",
        "Nonce cookie is missing - restart the login flow",
      );
    }

    if (tokenResponse.id_token && (requiresIdToken || storedNonce)) {
      // Decoding is strict: a malformed token is a 400, never a skipped check.
      const payload = oauth2Service.decodeIdTokenPayload(tokenResponse.id_token);
      const tokenNonce = typeof payload.nonce === "string" ? payload.nonce : undefined;

      if (!oauth2Service.verifyNonce(storedNonce, tokenNonce)) {
        return failOAuth(res, 400, "nonce_mismatch", "Nonce validation failed");
      }
    }

    // Fetch user info from provider
    const userInfo = await oauth2Service.fetchUserInfo(provider, tokenResponse.access_token);

    // Generate application JWT. `sub` is namespaced by provider: provider user
    // ids are only unique per-provider, so a raw id would let e.g. GitHub user
    // 12345 and Google user 12345 share one ChronoPay identity.
    const jwtSecret = configService.getSecret("JWT_SECRET");
    const appJwt = await signJwt(
      {
        sub: oauth2Service.buildAppSubject(userInfo.provider, userInfo.id),
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
    clearOAuthCookies(res);

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
    clearOAuthCookies(res);

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
