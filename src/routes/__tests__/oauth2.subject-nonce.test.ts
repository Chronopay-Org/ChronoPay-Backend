/**
 * Security regression coverage for issue #1341:
 *
 *  - the app JWT `sub` is namespaced by provider, so two providers that
 *    happen to use the same provider-local id do not share an identity;
 *  - OIDC providers (Google) must return an ID token whose nonce matches the
 *    cookie set at /start. A missing, malformed, or mismatched token is a 400
 *    and never a skipped check.
 *
 * The `oauth2Service` singleton is mocked, so the tests cover the route's
 * decision logic rather than provider HTTP calls.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { verifyJwt } from "../../utils/jwt.js";
import { configService } from "../../config/config.service.js";

// The OAuth2 provider registry is built when the service singleton is
// constructed, which happens on first import. Seed the provider env before
// importing the router so Google is registered as an OIDC provider.
process.env.OAUTH_GOOGLE_CLIENT_ID = "google-client-id";
process.env.OAUTH_GOOGLE_CLIENT_SECRET = "google-client-secret";
process.env.OAUTH_GOOGLE_REDIRECT_URI = "http://localhost:3000/callback";
process.env.OAUTH_GITHUB_CLIENT_ID = "github-client-id";
process.env.OAUTH_GITHUB_CLIENT_SECRET = "github-client-secret";
process.env.OAUTH_GITHUB_REDIRECT_URI = "http://localhost:3000/callback";

const { default: oauth2Router } = await import("../oauth2.js");
const { oauth2Service, OAuth2Error } = await import("../../services/oauth2.service.js");

const STATE = "state-abc123";
const NONCE = "nonce-abc123";
const SHARED_PROVIDER_USER_ID = "12345";

const GOOGLE_USER = {
  id: SHARED_PROVIDER_USER_ID,
  email: "shared@example.com",
  name: "Shared Id",
  provider: "google" as const,
};

const GITHUB_USER = {
  id: SHARED_PROVIDER_USER_ID,
  email: "shared@example.com",
  name: "Shared Id",
  provider: "github" as const,
};

/** JWT-shaped ID token with a base64url payload (signature is not verified). */
function makeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub: SHARED_PROVIDER_USER_ID,
      ...payload,
    }),
  ).toString("base64url");
  return `${header}.${body}.signature`;
}

function cookieHeader(options: { includeNonce?: boolean } = {}): string {
  const cookies = [
    `oauth2_state=${STATE}`,
    `oauth2_pkce=${encodeURIComponent(
      JSON.stringify({ verifier: "test-verifier", challenge: "test-challenge" }),
    )}`,
  ];

  if (options.includeNonce !== false) {
    cookies.push(`oauth2_nonce=${NONCE}`);
  }

  return cookies.join("; ");
}

// `provider` is read from the query string by the callback handler.
function callbackUrl(provider: "google" | "github"): string {
  return `/oauth/${provider}/callback?provider=${provider}&code=auth-code&state=${STATE}`;
}

function clearedCookies(res: request.Response): string[] {
  return (res.headers["set-cookie"] as string[] | undefined) ?? [];
}

function expectAllCookiesCleared(res: request.Response): void {
  const cleared = clearedCookies(res).filter((cookie) =>
    cookie.includes("Expires=Thu, 01 Jan 1970"),
  );
  expect(cleared.some((cookie) => cookie.startsWith("oauth2_state=;"))).toBe(true);
  expect(cleared.some((cookie) => cookie.startsWith("oauth2_pkce=;"))).toBe(true);
  expect(cleared.some((cookie) => cookie.startsWith("oauth2_nonce=;"))).toBe(true);
}

describe("OAuth2 callback security", () => {
  let app: express.Express;

  beforeEach(() => {
    // The provider registry is env-driven: Google must be configured so it is
    // treated as an OIDC provider (openid scope) by the route.
    process.env.OAUTH_GOOGLE_CLIENT_ID = "google-client-id";
    process.env.OAUTH_GOOGLE_CLIENT_SECRET = "google-client-secret";
    process.env.OAUTH_GOOGLE_REDIRECT_URI = "http://localhost:3000/callback";
    process.env.OAUTH_GITHUB_CLIENT_ID = "github-client-id";
    process.env.OAUTH_GITHUB_CLIENT_SECRET = "github-client-secret";
    process.env.OAUTH_GITHUB_REDIRECT_URI = "http://localhost:3000/callback";
    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.JWT_ISSUER = "test-issuer";
    process.env.JWT_AUDIENCE = "test-audience";
    configService.refresh();

    app = express();
    app.use(express.json());
    // Minimal cookie parser: the route only reads oauth2_* cookies.
    app.use((req: any, _res, next) => {
      req.cookies = {};
      const cookieHeaderValue = req.headers.cookie;
      if (cookieHeaderValue) {
        cookieHeaderValue.split(";").forEach((cookie: string) => {
          const [key, val] = cookie.split("=");
          if (key && val) {
            req.cookies[key.trim()] = decodeURIComponent(val.trim());
          }
        });
      }
      next();
    });
    app.use("/oauth", oauth2Router);

    jest.spyOn(oauth2Service, "getEnabledProviders").mockReturnValue(["google", "github"]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.OAUTH_GOOGLE_CLIENT_ID;
    delete process.env.OAUTH_GOOGLE_CLIENT_SECRET;
    delete process.env.OAUTH_GOOGLE_REDIRECT_URI;
    delete process.env.OAUTH_GITHUB_CLIENT_ID;
    delete process.env.OAUTH_GITHUB_CLIENT_SECRET;
    delete process.env.OAUTH_GITHUB_REDIRECT_URI;
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
  });

  it("gives the same provider-local id different subjects on different providers", async () => {
    jest.spyOn(oauth2Service, "exchangeCodeForToken").mockResolvedValueOnce({
      access_token: "google-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: makeIdToken({ nonce: NONCE }),
    });
    jest.spyOn(oauth2Service, "fetchUserInfo").mockResolvedValueOnce(GOOGLE_USER);

    const googleRes = await request(app).get(callbackUrl("google")).set("Cookie", cookieHeader());

    expect(googleRes.status).toBe(200);

    // GitHub is plain OAuth2 and returns no ID token.
    jest.spyOn(oauth2Service, "exchangeCodeForToken").mockResolvedValueOnce({
      access_token: "github-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
    jest.spyOn(oauth2Service, "fetchUserInfo").mockResolvedValueOnce(GITHUB_USER);

    const githubRes = await request(app).get(callbackUrl("github")).set("Cookie", cookieHeader());

    expect(githubRes.status).toBe(200);

    const googlePayload = await verifyJwt(googleRes.body.token, {
      issuer: "test-issuer",
      audience: "test-audience",
    });
    const githubPayload = await verifyJwt(githubRes.body.token, {
      issuer: "test-issuer",
      audience: "test-audience",
    });

    expect(googlePayload.sub).toBe(`google:${SHARED_PROVIDER_USER_ID}`);
    expect(githubPayload.sub).toBe(`github:${SHARED_PROVIDER_USER_ID}`);
    expect(googlePayload.sub).not.toBe(githubPayload.sub);
  });

  it("returns 400 when an OIDC provider omits the ID token", async () => {
    jest.spyOn(oauth2Service, "exchangeCodeForToken").mockResolvedValueOnce({
      access_token: "google-token",
      token_type: "Bearer",
      expires_in: 3600,
    }); // Mocked so a regression that continues after the failed check returns
    // 200 (instead of crashing) and the status assertion catches it.
    const fetchUserInfo = jest
      .spyOn(oauth2Service, "fetchUserInfo")
      .mockResolvedValueOnce(GOOGLE_USER);

    const res = await request(app).get(callbackUrl("google")).set("Cookie", cookieHeader());

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: "missing_id_token" });
    expect(fetchUserInfo).not.toHaveBeenCalled();
    expectAllCookiesCleared(res);
  });

  it("returns 400 for a malformed ID token instead of skipping nonce validation", async () => {
    jest.spyOn(oauth2Service, "exchangeCodeForToken").mockResolvedValueOnce({
      access_token: "google-token",
      token_type: "Bearer",
      expires_in: 3600,
      // Previously the decode threw and the catch block skipped the nonce check.
      id_token: "not-a-jwt",
    });
    const fetchUserInfo = jest
      .spyOn(oauth2Service, "fetchUserInfo")
      .mockResolvedValueOnce(GOOGLE_USER);

    const res = await request(app).get(callbackUrl("google")).set("Cookie", cookieHeader());

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: "malformed_id_token" });
    expect(fetchUserInfo).not.toHaveBeenCalled();
    expectAllCookiesCleared(res);
  });

  it("returns 400 for a non-JSON ID token payload", async () => {
    jest.spyOn(oauth2Service, "exchangeCodeForToken").mockResolvedValueOnce({
      access_token: "google-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: `header.${Buffer.from("not json").toString("base64url")}.signature`,
    });

    const res = await request(app).get(callbackUrl("google")).set("Cookie", cookieHeader());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("malformed_id_token");
    expectAllCookiesCleared(res);
  });

  it("returns 400 for a wrong nonce", async () => {
    jest.spyOn(oauth2Service, "exchangeCodeForToken").mockResolvedValueOnce({
      access_token: "google-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: makeIdToken({ nonce: "some-other-nonce" }),
    });
    const fetchUserInfo = jest
      .spyOn(oauth2Service, "fetchUserInfo")
      .mockResolvedValueOnce(GOOGLE_USER);

    const res = await request(app).get(callbackUrl("google")).set("Cookie", cookieHeader());

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: "nonce_mismatch" });
    expect(fetchUserInfo).not.toHaveBeenCalled();
    expectAllCookiesCleared(res);
  });

  it("returns 400 when the nonce cookie is missing", async () => {
    jest.spyOn(oauth2Service, "exchangeCodeForToken").mockResolvedValueOnce({
      access_token: "google-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: makeIdToken({ nonce: NONCE }),
    });

    const res = await request(app)
      .get(callbackUrl("google"))
      .set("Cookie", cookieHeader({ includeNonce: false }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: "missing_nonce" });
    expectAllCookiesCleared(res);
  });

  it("clears the OAuth cookies when the token exchange fails", async () => {
    jest
      .spyOn(oauth2Service, "exchangeCodeForToken")
      .mockRejectedValueOnce(
        new OAuth2Error("token_exchange_failed", "Failed to exchange code for token", 400),
      );

    const res = await request(app).get(callbackUrl("google")).set("Cookie", cookieHeader());

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: "token_exchange_failed" });
    expectAllCookiesCleared(res);
  });
});
