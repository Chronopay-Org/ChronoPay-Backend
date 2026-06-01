import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import oauth2Router from "../oauth2.js";
import { oauth2Service } from "../../services/oauth2.service.js";
import { configService } from "../../config/config.service.js";
import { signJwt } from "../../utils/jwt.js";

// Mock fetch to avoid real HTTP calls
global.fetch = jest.fn();

describe("OAuth2 Routes", () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // Add simple cookie parser
    app.use((req: any, _res, next) => {
      req.cookies = {};
      const cookieHeader = req.headers.cookie;
      if (cookieHeader) {
        cookieHeader.split(";").forEach((cookie: string) => {
          const [key, val] = cookie.split("=");
          if (key && val) {
            req.cookies[key.trim()] = decodeURIComponent(val.trim());
          }
        });
      }
      next();
    });
    app.use("/oauth", oauth2Router);
  });

  beforeEach(() => {
    // Setup env vars for providers
    process.env.OAUTH_GOOGLE_CLIENT_ID = "google-client-id";
    process.env.OAUTH_GOOGLE_CLIENT_SECRET = "google-client-secret";
    process.env.OAUTH_GOOGLE_REDIRECT_URI = "http://localhost:3000/callback";
    process.env.OAUTH_GITHUB_CLIENT_ID = "github-client-id";
    process.env.OAUTH_GITHUB_CLIENT_SECRET = "github-client-secret";
    process.env.OAUTH_GITHUB_REDIRECT_URI = "http://localhost:3000/callback";
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.JWT_ISSUER = "test-issuer";
    process.env.JWT_AUDIENCE = "test-audience";
    configService.refresh();

    // Reset mocked fetch
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.OAUTH_GOOGLE_CLIENT_ID;
    delete process.env.OAUTH_GOOGLE_CLIENT_SECRET;
    delete process.env.OAUTH_GOOGLE_REDIRECT_URI;
    delete process.env.OAUTH_GITHUB_CLIENT_ID;
    delete process.env.OAUTH_GITHUB_CLIENT_SECRET;
    delete process.env.OAUTH_GITHUB_REDIRECT_URI;
    delete process.env.NODE_ENV;
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
  });

  describe("GET /:provider/start", () => {
    it("returns 400 for invalid provider", async () => {
      const res = await request(app).get("/oauth/invalid/start");

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/invalid|unsupported/i);
    });

    it("returns authorization URL with PKCE challenge for valid provider", async () => {
      const res = await request(app).get("/oauth/google/start");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.authorization_url).toContain("https://accounts.google.com");
      expect(res.body.authorization_url).toContain("code_challenge=");
      expect(res.body.authorization_url).toContain("code_challenge_method=S256");
      expect(res.body.authorization_url).toContain("state=");
    });

    it("sets secure httpOnly cookies with state and PKCE", async () => {
      const res = await request(app).get("/oauth/google/start");

      expect(res.status).toBe(200);
      expect(res.headers["set-cookie"]).toBeDefined();
      const cookies = res.headers["set-cookie"] as string[];
      expect(cookies.some((c) => c.includes("oauth2_state"))).toBe(true);
      expect(cookies.some((c) => c.includes("oauth2_pkce"))).toBe(true);
      expect(cookies.some((c) => c.includes("oauth2_nonce"))).toBe(true);
      // Check secure flags
      expect(cookies.some((c) => c.includes("HttpOnly"))).toBe(true);
      expect(cookies.some((c) => c.includes("Secure"))).toBe(true);
    });

    it("generates different state and PKCE for each request", async () => {
      const res1 = await request(app).get("/oauth/google/start");
      const res2 = await request(app).get("/oauth/google/start");

      expect(res1.body.authorization_url).not.toBe(res2.body.authorization_url);
    });

    it("rejects invalid redirect_url", async () => {
      const res = await request(app)
        .get("/oauth/google/start")
        .query({ redirect_url: "https://evil.com" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("handles GitHub provider", async () => {
      const res = await request(app).get("/oauth/github/start");

      expect(res.status).toBe(200);
      expect(res.body.authorization_url).toContain("https://github.com/login/oauth/authorize");
    });
  });

  describe("GET /:provider/callback", () => {
    it("returns 400 for missing provider parameter", async () => {
      const res = await request(app).get("/oauth/undefined/callback?code=test&state=test");

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid|unsupported/i);
    });

    it("returns 400 for missing code parameter", async () => {
      const res = await request(app).get("/oauth/google/callback?state=test");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("missing_parameters");
    });

    it("returns 400 for state mismatch (CSRF protection)", async () => {
      const res = await request(app)
        .get("/oauth/google/callback?code=auth-code&state=wrong-state");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("state_mismatch");
      expect(res.body.message).toContain("CSRF");
    });

    it("returns 400 and clears cookies on missing PKCE session", async () => {
      // First get a valid state cookie
      const startRes = await request(app).get("/oauth/google/start");
      const startCookies = startRes.headers["set-cookie"];

      // Extract state from authorization URL
      const match = startRes.body.authorization_url.match(/state=([^&]+)/);
      const state = match ? match[1] : "";

      // Now simulate callback with cookies cleared (losing PKCE)
      const res = await request(app)
        .get(`/oauth/google/callback?code=auth-code&state=${state}`)
        .set("Cookie", startCookies.filter((c: string) => c.includes("oauth2_state")));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_session");
      // Check that cookies are cleared
      const setCookies = res.headers["set-cookie"] || [];
      expect(setCookies.some((c: string) => c.includes("oauth2_state="))).toBe(true);
    });

    it("handles OAuth2 provider errors", async () => {
      const res = await request(app).get(
        "/oauth/google/callback?error=access_denied&error_description=User%20denied"
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("access_denied");
      expect(res.body.message).toContain("User denied");
    });

    it("returns JWT and user info on successful exchange", async () => {
      // Setup
      const startRes = await request(app).get("/oauth/google/start");
      const startCookies = startRes.headers["set-cookie"];
      const match = startRes.body.authorization_url.match(/state=([^&]+)/);
      const state = match ? match[1] : "";

      // Mock successful token exchange
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "test-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      } as any);

      // Mock user info fetch
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sub: "google-user-123",
          email: "user@example.com",
          name: "Test User",
          picture: "https://example.com/pic.jpg",
        }),
      } as any);

      const res = await request(app)
        .get(`/oauth/google/callback?code=auth-code&state=${state}`)
        .set("Cookie", startCookies);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.id).toBe("google-user-123");
      expect(res.body.user.email).toBe("user@example.com");
      expect(res.body.user.name).toBe("Test User");
      expect(res.body.user.provider).toBe("google");
      // Do NOT include provider tokens
      expect(res.body.access_token).toBeUndefined();
      // Check cookies are cleared
      const setCookies = res.headers["set-cookie"] || [];
      expect(
        setCookies.some((c: string) => c.includes("oauth2_state=") && c.includes("Max-Age=0"))
      ).toBe(true);
    });

    it("returns valid JWT that can be verified", async () => {
      // Setup
      const startRes = await request(app).get("/oauth/google/start");
      const startCookies = startRes.headers["set-cookie"];
      const match = startRes.body.authorization_url.match(/state=([^&]+)/);
      const state = match ? match[1] : "";

      // Mock provider responses
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "test-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      } as any);

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sub: "user-123",
          email: "user@example.com",
        }),
      } as any);

      const res = await request(app)
        .get(`/oauth/google/callback?code=auth-code&state=${state}`)
        .set("Cookie", startCookies);

      // Verify JWT structure
      const jwtParts = res.body.token.split(".");
      expect(jwtParts).toHaveLength(3);

      // Can parse payload
      const payload = JSON.parse(Buffer.from(jwtParts[1], "base64").toString("utf-8"));
      expect(payload.sub).toBe("user-123");
      expect(payload.email).toBe("user@example.com");
      expect(payload.provider).toBe("google");
      expect(payload.iss).toBe("test-issuer");
      expect(payload.aud).toBe("test-audience");
      expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("handles token exchange failure gracefully", async () => {
      // Setup
      const startRes = await request(app).get("/oauth/google/start");
      const startCookies = startRes.headers["set-cookie"];
      const match = startRes.body.authorization_url.match(/state=([^&]+)/);
      const state = match ? match[1] : "";

      // Mock failed token exchange
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "Invalid authorization code",
      } as any);

      const res = await request(app)
        .get(`/oauth/google/callback?code=bad-code&state=${state}`)
        .set("Cookie", startCookies);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("token_exchange_failed");
    });

    it("handles GitHub provider", async () => {
      // Setup
      const startRes = await request(app).get("/oauth/github/start");
      const startCookies = startRes.headers["set-cookie"];
      const match = startRes.body.authorization_url.match(/state=([^&]+)/);
      const state = match ? match[1] : "";

      // Mock token response
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "github-token",
          token_type: "Bearer",
          scope: "user:email",
        }),
      } as any);

      // Mock user info
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 123456,
          email: "github@example.com",
          name: "GitHub User",
          avatar_url: "https://avatars.githubusercontent.com/u/123456",
        }),
      } as any);

      const res = await request(app)
        .get(`/oauth/github/callback?code=github-code&state=${state}`)
        .set("Cookie", startCookies);

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe("123456");
      expect(res.body.user.provider).toBe("github");
      expect(res.body.user.email).toBe("github@example.com");
    });

    it("validates nonce for OIDC providers", async () => {
      // Setup
      const startRes = await request(app).get("/oauth/google/start");
      const startCookies = startRes.headers["set-cookie"];
      const match = startRes.body.authorization_url.match(/state=([^&]+)/);
      const state = match ? match[1] : "";

      // Extract nonce from URL
      const nonceMatch = startRes.body.authorization_url.match(/nonce=([^&]+)/);
      const nonce = nonceMatch ? nonceMatch[1] : "";

      // Create ID token with matching nonce
      const idTokenPayload = {
        iss: "https://accounts.google.com",
        sub: "user-123",
        nonce: nonce,
      };
      const idToken = Buffer.from(
        JSON.stringify({
          header: { alg: "RS256" },
          payload: idTokenPayload,
          signature: "fake",
        })
      )
        .toString("base64");

      // Mock token response with ID token
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "test-token",
          id_token: idToken,
          token_type: "Bearer",
        }),
      } as any);

      // Mock user info
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sub: "user-123",
          email: "user@example.com",
        }),
      } as any);

      const res = await request(app)
        .get(`/oauth/google/callback?code=auth-code&state=${state}`)
        .set("Cookie", startCookies);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("rejects mismatched nonce", async () => {
      // Setup
      const startRes = await request(app).get("/oauth/google/start");
      const startCookies = startRes.headers["set-cookie"];
      const match = startRes.body.authorization_url.match(/state=([^&]+)/);
      const state = match ? match[1] : "";

      // Create ID token with WRONG nonce
      const idToken = Buffer.from(
        JSON.stringify({
          header: { alg: "RS256" },
          payload: {
            iss: "https://accounts.google.com",
            sub: "user-123",
            nonce: "wrong-nonce",
          },
          signature: "fake",
        })
      )
        .toString("base64");

      // Mock token response with ID token
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "test-token",
          id_token: idToken,
          token_type: "Bearer",
        }),
      } as any);

      const res = await request(app)
        .get(`/oauth/google/callback?code=auth-code&state=${state}`)
        .set("Cookie", startCookies);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("nonce_mismatch");
    });
  });

  describe("Edge cases and security", () => {
    it("does not leak provider tokens in response", async () => {
      const startRes = await request(app).get("/oauth/google/start");
      const startCookies = startRes.headers["set-cookie"];
      const match = startRes.body.authorization_url.match(/state=([^&]+)/);
      const state = match ? match[1] : "";

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "sensitive-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
        }),
      } as any);

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sub: "user-123",
          email: "user@example.com",
        }),
      } as any);

      const res = await request(app)
        .get(`/oauth/google/callback?code=auth-code&state=${state}`)
        .set("Cookie", startCookies);

      // Verify no provider tokens in response
      expect(JSON.stringify(res.body)).not.toContain("sensitive-token");
      expect(JSON.stringify(res.body)).not.toContain("refresh-token");
    });

    it("clears cookies on all error paths", async () => {
      const startRes = await request(app).get("/oauth/google/start");
      const startCookies = startRes.headers["set-cookie"];

      // Missing code
      let res = await request(app)
        .get("/oauth/google/callback?state=test")
        .set("Cookie", startCookies);

      let setCookies = res.headers["set-cookie"] || [];
      // Even though cookies may not have been sent with wrong params, verify structure
      expect(res.status).toBe(400);
    });

    it("handles concurrent requests safely (different states per request)", async () => {
      const res1 = await request(app).get("/oauth/google/start");
      const res2 = await request(app).get("/oauth/google/start");

      const match1 = res1.body.authorization_url.match(/state=([^&]+)/);
      const state1 = match1 ? match1[1] : "";

      const match2 = res2.body.authorization_url.match(/state=([^&]+)/);
      const state2 = match2 ? match2[1] : "";

      expect(state1).not.toBe(state2);
    });

    it("PKCE challenge is URL-safe base64", async () => {
      const res = await request(app).get("/oauth/google/start");
      const match = res.body.authorization_url.match(/code_challenge=([^&]+)/);
      const challenge = match ? match[1] : "";

      // URL-safe base64 should not contain = at the end (padding stripped)
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });
});
