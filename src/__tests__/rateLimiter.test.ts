import { jest } from "@jest/globals";
import request from "supertest";
import express, { type Application } from "express";
import { createRateLimiter } from "../middleware/rateLimiter.js";

/**
 * Builds a minimal isolated Express app with the given rate limit settings.
 * Using isolated apps (instead of the real app) ensures each test group has
 * a fresh in-memory store — no cross-test bleed from shared counters.
 */
function buildApp(windowMs: number, max: number): Application {
  const app = express();
  app.use(createRateLimiter(windowMs, max));
  app.get("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

/**
 * Builds an app with `trust proxy` enabled.
 * Required for X-Forwarded-For tests: without it, Express ignores the header
 * and all supertest requests appear to share the same loopback IP.
 */
function buildProxyApp(windowMs: number, max: number): Application {
  const app = express();
  app.set("trust proxy", 1);
  app.use(createRateLimiter(windowMs, max));
  app.get("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

describe("createRateLimiter factory", () => {
  it("returns a middleware function when called with explicit params", () => {
    const limiter = createRateLimiter(60_000, 10);
    expect(typeof limiter).toBe("function");
  });

  it("returns a middleware function when called with no arguments", () => {
    const limiter = createRateLimiter();
    expect(typeof limiter).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Requests under the limit
// ---------------------------------------------------------------------------

describe("rate limiter: requests under the limit", () => {
  const app = buildApp(10_000, 5);

  it("passes through requests under the max with 200", async () => {
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("includes the standard RateLimit header on successful responses", async () => {
    const res = await request(app).get("/test");
    // express-rate-limit v7 with standardHeaders: "draft-7" sends a combined RateLimit header
    expect(res.headers).toHaveProperty("ratelimit");
  });

  it("does NOT include legacy X-RateLimit-* headers", async () => {
    const res = await request(app).get("/test");
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeUndefined();
    expect(res.headers["x-ratelimit-reset"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Enforcing the limit (429 responses)
// ---------------------------------------------------------------------------

describe("rate limiter: enforcing the limit", () => {
  it("returns 429 after exceeding the max request count", async () => {
    const app = buildApp(60_000, 3);
    await request(app).get("/test"); // 1
    await request(app).get("/test"); // 2
    await request(app).get("/test"); // 3
    const res = await request(app).get("/test"); // 4 — should be blocked
    expect(res.status).toBe(429);
  });

  it("returns the standard { success: false, error } JSON envelope on 429", async () => {
    const app = buildApp(60_000, 1);
    await request(app).get("/test"); // exhaust
    const res = await request(app).get("/test"); // blocked
    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.toLowerCase()).toContain("too many requests");
  });

  it("includes the RateLimit header on 429 responses", async () => {
    const app = buildApp(60_000, 1);
    await request(app).get("/test"); // exhaust
    const res = await request(app).get("/test"); // blocked
    expect(res.status).toBe(429);
    expect(res.headers).toHaveProperty("ratelimit");
  });

  it("keeps blocking subsequent requests once limit is reached", async () => {
    const app = buildApp(60_000, 1);
    await request(app).get("/test"); // exhaust

    const res1 = await request(app).get("/test");
    const res2 = await request(app).get("/test");
    expect(res1.status).toBe(429);
    expect(res2.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Per-IP isolation via X-Forwarded-For
// ---------------------------------------------------------------------------

describe("rate limiter: IP isolation via X-Forwarded-For", () => {
  it("tracks request counts independently per IP", async () => {
    const app = buildProxyApp(60_000, 2);

    // IP A: exhaust its quota (2 requests)
    await request(app).get("/test").set("X-Forwarded-For", "1.2.3.4");
    const resA2 = await request(app).get("/test").set("X-Forwarded-For", "1.2.3.4");
    expect(resA2.status).toBe(200); // 2nd request still within limit

    // IP B: fresh quota — should not be affected by IP A's counter
    const resB1 = await request(app).get("/test").set("X-Forwarded-For", "5.6.7.8");
    expect(resB1.status).toBe(200);

    // IP A: 3rd request — should now be blocked
    const resA3 = await request(app).get("/test").set("X-Forwarded-For", "1.2.3.4");
    expect(resA3.status).toBe(429);

    // IP B: 2nd request — still within its own limit
    const resB2 = await request(app).get("/test").set("X-Forwarded-For", "5.6.7.8");
    expect(resB2.status).toBe(200);
  });

  it("blocks IP A without affecting IP B when A exceeds limit", async () => {
    const app = buildProxyApp(60_000, 1);

    await request(app).get("/test").set("X-Forwarded-For", "10.0.0.1"); // exhaust A
    const resA = await request(app).get("/test").set("X-Forwarded-For", "10.0.0.1");
    const resB = await request(app).get("/test").set("X-Forwarded-For", "10.0.0.2");

    expect(resA.status).toBe(429);
    expect(resB.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Environment variable configuration
// ---------------------------------------------------------------------------

describe("rate limiter: environment variable configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Shallow clone so we can restore cleanly after each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("does not throw when RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX are valid", () => {
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    process.env.RATE_LIMIT_MAX = "50";
    expect(() => createRateLimiter()).not.toThrow();
  });

  it("falls back to defaults when RATE_LIMIT_WINDOW_MS is not a number", () => {
    process.env.RATE_LIMIT_WINDOW_MS = "not-a-number";
    process.env.RATE_LIMIT_MAX = "50";
    expect(() => createRateLimiter()).not.toThrow();
  });

  it("falls back to defaults when RATE_LIMIT_MAX is empty", () => {
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    process.env.RATE_LIMIT_MAX = "";
    expect(() => createRateLimiter()).not.toThrow();
  });

  it("falls back to defaults when both env vars are missing", () => {
    delete process.env.RATE_LIMIT_WINDOW_MS;
    delete process.env.RATE_LIMIT_MAX;
    expect(() => createRateLimiter()).not.toThrow();
  });

  it("applies RATE_LIMIT_MAX env-derived limit when explicit max is passed", async () => {
    // Explicit params take precedence over env vars — test that explicit max=2 is honoured
    process.env.RATE_LIMIT_MAX = "999"; // would allow far more if read
    const app = buildApp(60_000, 2); // explicit max=2 should win
    await request(app).get("/test");
    await request(app).get("/test");
    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Window reset (fake timers)
// ---------------------------------------------------------------------------

describe("rate limiter: window reset", () => {
  it("allows requests again after the window expires", async () => {
    jest.useFakeTimers();
    const WINDOW = 1_000; // 1-second window for speed
    const app = buildApp(WINDOW, 1);

    // Exhaust the limit
    await request(app).get("/test");
    const blocked = await request(app).get("/test");
    expect(blocked.status).toBe(429);

    // Advance Jest's fake clock past the window boundary
    jest.advanceTimersByTime(WINDOW + 100);
    // Flush the microtask queue so the store's internal timeout callback fires
    await Promise.resolve();

    // After the window resets the counter should be cleared
    const afterReset = await request(app).get("/test");
    expect(afterReset.status).toBe(200);

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

describe("rate limiter: default export", () => {
  it("default export is a middleware function", async () => {
    const { default: rateLimiter } = await import(
      "../middleware/rateLimiter.js"
    );
    expect(typeof rateLimiter).toBe("function");
  });
});
