import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import { isOriginAllowed, getCORSConfig, validateCORSConfig, type CORSConfig } from "../config/cors.js";
import { createCORSMiddleware } from "../middleware/cors.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeApp(config: CORSConfig) {
  const app = express();
  app.use(createCORSMiddleware(config));
  app.get("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

const baseConfig: CORSConfig = {
  allowedOrigins: ["https://allowed.example.com"],
  allowedMethods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  allowCredentials: true,
  maxAge: 3600,
};

// ── isOriginAllowed ───────────────────────────────────────────────────────────

describe("isOriginAllowed", () => {
  it("allows an exact match", () => {
    expect(isOriginAllowed("https://allowed.example.com", ["https://allowed.example.com"])).toBe(true);
  });

  it("rejects an origin not in the list", () => {
    expect(isOriginAllowed("https://evil.com", ["https://allowed.example.com"])).toBe(false);
  });

  it("rejects undefined origin", () => {
    expect(isOriginAllowed(undefined, ["https://allowed.example.com"])).toBe(false);
  });

  it("rejects empty string origin", () => {
    expect(isOriginAllowed("", ["https://allowed.example.com"])).toBe(false);
  });

  it("rejects whitespace-only origin", () => {
    expect(isOriginAllowed("   ", ["https://allowed.example.com"])).toBe(false);
  });

  it("rejects a malformed origin (not a valid URL)", () => {
    expect(isOriginAllowed("not-a-url", ["not-a-url"])).toBe(false);
  });

  it("rejects when allowedOrigins is empty", () => {
    expect(isOriginAllowed("https://allowed.example.com", [])).toBe(false);
  });

  it("is case-sensitive for exact matches", () => {
    expect(isOriginAllowed("https://Allowed.Example.Com", ["https://allowed.example.com"])).toBe(false);
  });

  it("does not match a subdomain against an exact origin", () => {
    expect(isOriginAllowed("https://sub.allowed.example.com", ["https://allowed.example.com"])).toBe(false);
  });

  it("does not match a different port", () => {
    expect(isOriginAllowed("https://allowed.example.com:8443", ["https://allowed.example.com"])).toBe(false);
  });

  // Wildcard patterns
  it("allows a subdomain matching a wildcard pattern", () => {
    expect(isOriginAllowed("https://app.example.com", ["https://*.example.com"])).toBe(true);
  });

  it("allows a deep subdomain matching a wildcard pattern", () => {
    expect(isOriginAllowed("https://a.b.example.com", ["https://*.example.com"])).toBe(true);
  });

  it("rejects the base domain when only a wildcard pattern is listed", () => {
    expect(isOriginAllowed("https://example.com", ["https://*.example.com"])).toBe(false);
  });

  it("rejects a wildcard-only pattern (*)", () => {
    // * alone is not a valid pattern — isOriginAllowed should not match it
    expect(isOriginAllowed("https://anything.com", ["*"])).toBe(false);
  });

  it("rejects a pattern with multiple wildcards", () => {
    expect(isOriginAllowed("https://a.b.example.com", ["https://*.*.example.com"])).toBe(false);
  });

  it("rejects a wildcard not followed by a dot (e.g. *.com)", () => {
    expect(isOriginAllowed("https://example.com", ["https://*com"])).toBe(false);
  });
});

// ── getCORSConfig ─────────────────────────────────────────────────────────────

describe("getCORSConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns localhost defaults in development", () => {
    process.env.NODE_ENV = "development";
    delete process.env.CORS_ALLOWED_ORIGINS;
    const config = getCORSConfig();
    expect(config.allowedOrigins).toContain("http://localhost:3000");
    expect(config.allowedOrigins).toContain("http://localhost:3001");
  });

  it("returns empty allowlist in production when env var is unset", () => {
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ALLOWED_ORIGINS;
    const config = getCORSConfig();
    expect(config.allowedOrigins).toHaveLength(0);
  });

  it("parses CORS_ALLOWED_ORIGINS from env", () => {
    process.env.NODE_ENV = "development";
    process.env.CORS_ALLOWED_ORIGINS = "https://a.com,https://b.com";
    const config = getCORSConfig();
    expect(config.allowedOrigins).toEqual(["https://a.com", "https://b.com"]);
  });

  it("trims whitespace from origins in env var", () => {
    process.env.NODE_ENV = "development";
    process.env.CORS_ALLOWED_ORIGINS = " https://a.com , https://b.com ";
    const config = getCORSConfig();
    expect(config.allowedOrigins).toEqual(["https://a.com", "https://b.com"]);
  });

  it("parses CORS_ALLOWED_ORIGINS in production", () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ALLOWED_ORIGINS = "https://app.chronopay.com";
    const config = getCORSConfig();
    expect(config.allowedOrigins).toEqual(["https://app.chronopay.com"]);
  });

  it("parses CORS_ALLOW_CREDENTIALS=false", () => {
    process.env.NODE_ENV = "development";
    process.env.CORS_ALLOW_CREDENTIALS = "false";
    const config = getCORSConfig();
    expect(config.allowCredentials).toBe(false);
  });

  it("parses CORS_MAX_AGE", () => {
    process.env.NODE_ENV = "development";
    process.env.CORS_MAX_AGE = "7200";
    const config = getCORSConfig();
    expect(config.maxAge).toBe(7200);
  });

  it("falls back to default maxAge for invalid CORS_MAX_AGE", () => {
    process.env.NODE_ENV = "development";
    process.env.CORS_MAX_AGE = "not-a-number";
    const config = getCORSConfig();
    expect(config.maxAge).toBe(86400);
  });
});

// ── validateCORSConfig ────────────────────────────────────────────────────────

describe("validateCORSConfig", () => {
  it("accepts a valid config", () => {
    expect(validateCORSConfig(baseConfig)).toBe(true);
  });

  it("throws for wildcard-only origin", () => {
    expect(() => validateCORSConfig({ ...baseConfig, allowedOrigins: ["*"] })).toThrow();
  });

  it("throws for an invalid origin URL", () => {
    expect(() => validateCORSConfig({ ...baseConfig, allowedOrigins: ["not-a-url"] })).toThrow();
  });

  it("throws for negative maxAge", () => {
    expect(() => validateCORSConfig({ ...baseConfig, maxAge: -1 })).toThrow();
  });

  it("accepts an empty allowedOrigins array", () => {
    expect(validateCORSConfig({ ...baseConfig, allowedOrigins: [] })).toBe(true);
  });
});

// ── createCORSMiddleware (HTTP integration) ───────────────────────────────────

describe("createCORSMiddleware", () => {
  it("sets CORS headers for an allowed origin", async () => {
    const app = makeApp(baseConfig);
    const res = await request(app)
      .get("/test")
      .set("Origin", "https://allowed.example.com");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://allowed.example.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not set CORS headers for a disallowed origin", async () => {
    const app = makeApp(baseConfig);
    const res = await request(app)
      .get("/test")
      .set("Origin", "https://evil.com");

    expect(res.status).toBe(200); // request still succeeds
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("processes requests with no Origin header without CORS headers", async () => {
    const app = makeApp(baseConfig);
    const res = await request(app).get("/test");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns 200 for a preflight OPTIONS from an allowed origin", async () => {
    const app = makeApp(baseConfig);
    const res = await request(app)
      .options("/test")
      .set("Origin", "https://allowed.example.com")
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://allowed.example.com");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("returns 403 for a preflight OPTIONS from a disallowed origin", async () => {
    const app = makeApp(baseConfig);
    const res = await request(app)
      .options("/test")
      .set("Origin", "https://evil.com")
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  it("sets Access-Control-Max-Age on preflight", async () => {
    const app = makeApp(baseConfig);
    const res = await request(app)
      .options("/test")
      .set("Origin", "https://allowed.example.com");

    expect(res.headers["access-control-max-age"]).toBe("3600");
  });

  it("does not set Allow-Credentials when allowCredentials is false", async () => {
    const app = makeApp({ ...baseConfig, allowCredentials: false });
    const res = await request(app)
      .get("/test")
      .set("Origin", "https://allowed.example.com");

    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("allows a wildcard-pattern origin", async () => {
    const app = makeApp({ ...baseConfig, allowedOrigins: ["https://*.example.com"] });
    const res = await request(app)
      .get("/test")
      .set("Origin", "https://app.example.com");

    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("rejects a non-matching subdomain against a wildcard pattern", async () => {
    const app = makeApp({ ...baseConfig, allowedOrigins: ["https://*.example.com"] });
    const res = await request(app)
      .get("/test")
      .set("Origin", "https://evil.org");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
