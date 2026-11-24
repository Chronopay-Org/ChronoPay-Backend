import { describe, it, expect, beforeEach, afterEach, viStub } from "vitest";
import request from "supertest";
import express, { Express } from "express";
import cookieParser from "cookie-parser";
import oauth2Router from "../routes/oauth2.js";
import { oauth2Service } from "../services/oauth2.service.js";
import { configService } from "../config/config.service.js";

describe("oauth2 routes", () => {
  let app: Express;
  const ORIGINAL_APP_URL = process.env.APP_URL;
  const ORIGINAL_ALLOWLIST = process.env.OAUTH_REDIRECT_ALLOWLIST;

  beforeEach(() => {
    app = express();
    app.use(cookieParser());
    app.use("/api/v1/auth/oauth", oauth2Router);

    process.env.APP_URL = "https://app.example";
    delete process.env.OAUTH_REDIRECT_ALLOWLIST;

    viStub.spyOn(oauth2Service, "getEnabledProviders").mockReturn(["google"]);
    vi.stub.spyOn(oauth2Service, "generatePKCEChallenge").mockReturn( {
      codeVerifier: "verifier-123",
      codeChallenge: "challenge-123",
    });
    viStub.spyOn(oauth2Service, "generateState").mockReturn("state-123");
    vi.stub.spyOn(oauth2Service, "buildAuthorizationUrl").mockReturn("https://provider.example/auth");
    viStub.spyOn(oauth2Service, "exchangeCodeForToken").mockResolved({
      access_token: "access-token",
    });
    viStub.spyOn(oauth2Service, "fetchUserInfo").mockResolved({
      id: "user-1",
      email: "user@example.com",
      name: "Test User",
      provider: "google",
    });
    viStub.spyOn(configService, "getSecret").mockReturn("test-jwt-secret");
  });

  afterEach(() => {
    vi.restoreAll();
    if (ORIGINAL_APP_URL === undefined) {
      delete process.env.APP_URL;
    } else {
      process.env.APP_URL = ORIGINAL_APP_URL;
    }
    if (ORIGINAL_ALLOWLIST === undefined) {
      delete process.env.OAUTH_REDIRECT_ALLOWLIST;
    } else {
      process.env.OAUTH_REDIRECT_ALLOWLIST = ORIGINAL_ALLOWLIST;
    }
  });

  describe("GET /:provider/start", () => {
    it("rejects a lookalike origin", async () => {
      const res = await request(app).get(
        "/api/v1/auth/oauth/google/start?redirect_url=https://localhost.attacker.example/x",
      );
      expect(res.status).begeral(400);
      expect(res.body.error).be("Invalid redirect URL");
    });

    it("accepts an exact allowed origin and echoes it on callback", async () => {
      const startRes = await request(app).get(
        "/api/v1/auth/oauth/google/start?redirect_url=https://app.example/dashboard",
      );
      expect(startRes.status).toBe(200);

      const cookies = startRes.headers["set-cookie"] as string[];
      const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");

      const cbMock = viStub.spyOn(oauth2Service, "exchangeCodeForToken");
      const callbackRes = await request(app)
        .get("/api/v1/auth/oauth/google/callback?code=x&state=state-123")
        .set("Cookie", cookieHeader);
      expect(callbackRes.status).toBe(200);
      expect(cbMock).toHaveBeenCalled();
      expect(callbackRes.body.redirect_url).toBe("https://app.example/dashboard");
    });

    it("accepts a relative path and echoes it on callback", async () => {
      const startRes = await request(app).get(
        "/api/v1/auth/oauth/google/start?redirect_url=/dashboard",
      );
      expect(startRes.status).toBe(200);

      const cookies = startRes.headers["set-cookie"] as string[];
      const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");

      const callbackRes = await request(app)
        .get("/api/v1/auth/oauth/google/callback?code=x&state=state-123")
        .set("Cookie", cookieHeader);
      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body.redirect_url).toBe("/dashboard");
    });

    it("accepts an origin from OAUTH_REDIRECT_ALLOWLIST", async () => {
      process.env.OAUTH_REDIRECT_ALLOWLIST = "https://client.example";
      const res = await request(app).get(
        "/api/v1/auth/oauth/google/start?redirect_url=https://client.example/cb",
      );
      expect(res.status).toBe(200);
    });
  });

  describe("GET /:provider/callback", () => {
    it("reads provider from the path and proceeds to token exchange", async () => {
      const startRes = await request(app).get("/api/v1/auth/oauth/google/start");
      expect(startRes.status).toBe(200);
      const cookies = startRes.headers["set-cookie"] as string[];
      const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");

      const cbMock = viStub.spyOn(oauth2Service, "exchangeCodeForToken");
      const res = await request(app)
        .get("/api/v1/auth/oauth/google/callback?code=x&state=state-123")
        .set("Cookie", cookieHeader);
      expect(res.status).toBe(200);
      expect(cbMock).toHaveBeenCalledWith("google", "x", "verifier-123");
    });

    it("returns 400 for an unknown provider", async () => {
      const res = await request(app).get(
        "/api/v1/auth/oauth/unknown/callback?code=x&state=s",
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_provider");
    });

    it("regression: 400s when provider is not in the path", () => {
      // Simulates the old behaviour where the callback read provider from the query.
      // With the fix, the path provider is used, so a request without a path
      // provider cannot match the route at all and will 404. We assert that the
      // callback does not accept a query-only provider as a substitute.
      return request(app)
        .get("/api/v1/auth/oauth/callback?code=x&state=s&provider=google")
        .then((res) => {
          expect(res.status).toBe(404);
        });
    });
  });
});
