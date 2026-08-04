/**
 * Tests for the internal fair-queue rate-limit bypass middleware.
 *
 * Covers:
 *   - Valid bypass (current secret, previous secret for rotation)
 *   - Missing headers (transparent pass-through)
 *   - Incomplete headers (bad_format)
 *   - Invalid actor format (bad_format)
 *   - Invalid timestamp format (bad_format)
 *   - Expired signature (outside tolerance window)
 *   - Wrong route (invalid_sig)
 *   - Invalid HMAC (invalid_sig)
 *   - No secret configured (invalid_sig)
 *   - Integration with createAuthAwareRateLimiter (bypass skips rate limiting)
 */

import { createHmac } from "node:crypto";
import { jest } from "@jest/globals";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "test-internal-secret-abc123";
const PREV_SECRET = "test-internal-prev-secret-xyz789";
const ACTOR = "payout-worker";
const ROUTE = "/api/v1/slots";
const TOLERANCE_MS = 30_000;

function makeSignature(
  actor: string,
  route: string,
  ts: number,
  secret: string,
): string {
  const message = `${actor}\n${route}\n${ts}`;
  return "sha256=" + createHmac("sha256", secret).update(message).digest("hex");
}

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Unit-level tests (middleware in isolation)
// ---------------------------------------------------------------------------

// Import lazily so module mocks (if any) can be applied first.
// For these tests we don't need to mock ConfigService — we pass overrides
// directly to fairQueueBypass().
const { fairQueueBypass } = await import("../internalHmacAuth.js");

function buildApp(
  secret?: string,
  prevSecret?: string,
  toleranceMs?: number,
): express.Express {
  const app = express();
  app.use(express.json());

  // Mount the bypass middleware before the test handler.
  app.use(
    fairQueueBypass(secret, prevSecret, toleranceMs ?? TOLERANCE_MS),
  );

  app.get(ROUTE, (req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      actor: (req as any).internalBypassActor ?? null,
    });
  });

  app.post(ROUTE, (req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      actor: (req as any).internalBypassActor ?? null,
    });
  });

  return app;
}

// ---------------------------------------------------------------------------

describe("fairQueueBypass middleware", () => {
  describe("when no bypass headers are present", () => {
    it("passes through silently without modifying the request", async () => {
      const app = buildApp(SECRET);
      const res = await request(app).get(ROUTE).expect(200);
      expect(res.body.actor).toBeNull();
    });
  });

  describe("valid bypass — current secret", () => {
    it("sets req.internalBypassActor and calls next()", async () => {
      const ts = nowTs();
      const sig = makeSignature(ACTOR, ROUTE, ts, SECRET);
      const app = buildApp(SECRET);

      const res = await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", sig)
        .expect(200);

      expect(res.body.actor).toBe(ACTOR);
    });

    it("accepts sig without 'sha256=' prefix (raw hex)", async () => {
      const ts = nowTs();
      // Create a raw hex signature (no prefix)
      const rawHex = createHmac("sha256", SECRET)
        .update(`${ACTOR}\n${ROUTE}\n${ts}`)
        .digest("hex");

      const app = buildApp(SECRET);
      const res = await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", rawHex)
        .expect(200);

      expect(res.body.actor).toBe(ACTOR);
    });
  });

  describe("valid bypass — previous secret (rotation)", () => {
    it("grants bypass when signed with the previous secret", async () => {
      const ts = nowTs();
      const sig = makeSignature(ACTOR, ROUTE, ts, PREV_SECRET);
      const app = buildApp(SECRET, PREV_SECRET);

      const res = await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", sig)
        .expect(200);

      expect(res.body.actor).toBe(ACTOR);
    });

    it("rejects when only prev secret is available and current secret no longer matches", async () => {
      const ts = nowTs();
      // Sign with prev secret but only provide curr secret (no prev configured)
      const sig = makeSignature(ACTOR, ROUTE, ts, PREV_SECRET);
      const app = buildApp(SECRET /* no prevSecret */);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", sig)
        .expect(403);
    });
  });

  describe("expired signature", () => {
    it("returns 403 when timestamp is too old", async () => {
      const staleTs = nowTs() - 60; // 60 s ago, tolerance is 30 s
      const sig = makeSignature(ACTOR, ROUTE, staleTs, SECRET);
      const app = buildApp(SECRET, undefined, TOLERANCE_MS);

      const res = await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(staleTs))
        .set("x-bypass-sig", sig)
        .expect(403);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/expired/i);
    });

    it("returns 403 when timestamp is too far in the future", async () => {
      const futureTs = nowTs() + 60;
      const sig = makeSignature(ACTOR, ROUTE, futureTs, SECRET);
      const app = buildApp(SECRET, undefined, TOLERANCE_MS);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(futureTs))
        .set("x-bypass-sig", sig)
        .expect(403);
    });

    it("accepts timestamp just within the tolerance window", async () => {
      // 29 s ago, tolerance 30 s → should pass
      const ts = nowTs() - 29;
      const sig = makeSignature(ACTOR, ROUTE, ts, SECRET);
      const app = buildApp(SECRET, undefined, TOLERANCE_MS);

      const res = await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", sig)
        .expect(200);

      expect(res.body.actor).toBe(ACTOR);
    });
  });

  describe("wrong route (replay on different endpoint)", () => {
    it("returns 403 when the signed route does not match the actual path", async () => {
      const ts = nowTs();
      // Sign for /api/v1/admin but actually request /api/v1/slots
      const wrongRouteSig = makeSignature(ACTOR, "/api/v1/admin", ts, SECRET);
      const app = buildApp(SECRET);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", wrongRouteSig)
        .expect(403);
    });
  });

  describe("invalid HMAC", () => {
    it("returns 403 for a tampered signature", async () => {
      const ts = nowTs();
      const sig = makeSignature(ACTOR, ROUTE, ts, SECRET);
      // Flip last char to tamper
      const tampered = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
      const app = buildApp(SECRET);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", tampered)
        .expect(403);
    });

    it("returns 403 when signed with completely wrong secret", async () => {
      const ts = nowTs();
      const sig = makeSignature(ACTOR, ROUTE, ts, "totally-wrong-secret");
      const app = buildApp(SECRET);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", sig)
        .expect(403);
    });
  });

  describe("no secret configured", () => {
    it("returns 403 when no secret is configured on the server", async () => {
      const ts = nowTs();
      const sig = makeSignature(ACTOR, ROUTE, ts, SECRET);
      // Pass undefined secret
      const app = buildApp(undefined /* no secret */);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", sig)
        .expect(403);
    });
  });

  describe("bad / incomplete headers", () => {
    it("returns 401 when x-bypass-actor is missing but other headers present", async () => {
      const ts = nowTs();
      const sig = makeSignature(ACTOR, ROUTE, ts, SECRET);
      const app = buildApp(SECRET);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", sig)
        .expect(401);
    });

    it("returns 401 when x-bypass-ts is missing but other headers present", async () => {
      const ts = nowTs();
      const sig = makeSignature(ACTOR, ROUTE, ts, SECRET);
      const app = buildApp(SECRET);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-sig", sig)
        .expect(401);
    });

    it("returns 401 when x-bypass-sig is missing but other headers present", async () => {
      const ts = nowTs();
      const app = buildApp(SECRET);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .expect(401);
    });

    it("returns 401 when actor contains invalid characters (whitespace)", async () => {
      const ts = nowTs();
      const sig = makeSignature("bad actor", ROUTE, ts, SECRET);
      const app = buildApp(SECRET);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", "bad actor") // space is invalid
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", sig)
        .expect(401);
    });

    it("returns 401 when actor is empty string (treated as missing)", async () => {
      const ts = nowTs();
      const sig = makeSignature("", ROUTE, ts, SECRET);
      const app = buildApp(SECRET);

      // Express may strip empty headers, but simulate sending it
      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", "")
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", sig)
        .expect(401);
    });

    it("returns 401 when timestamp is not an integer", async () => {
      const ts = nowTs();
      const sig = makeSignature(ACTOR, ROUTE, ts, SECRET);
      const app = buildApp(SECRET);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", "not-a-number")
        .set("x-bypass-sig", sig)
        .expect(401);
    });

    it("returns 401 when timestamp is a float string", async () => {
      const ts = nowTs();
      const sig = makeSignature(ACTOR, ROUTE, ts, SECRET);
      const app = buildApp(SECRET);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", "1234567890.5")
        .set("x-bypass-sig", sig)
        .expect(401);
    });

    it("returns 401 when signature is not valid hex", async () => {
      const ts = nowTs();
      const app = buildApp(SECRET);

      await request(app)
        .get(ROUTE)
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", "sha256=notahexvalue!")
        .expect(401);
    });
  });

  describe("replay attack", () => {
    it("same valid token used on a different route is rejected (wrong_route / invalid_sig)", async () => {
      const ts = nowTs();
      // Create two apps, route A and route B
      const sig = makeSignature(ACTOR, "/api/v1/slots", ts, SECRET);

      const appB = express();
      appB.use(express.json());
      appB.use(fairQueueBypass(SECRET, undefined, TOLERANCE_MS));
      appB.get("/api/v1/bookings", (req: Request, res: Response) => {
        res.status(200).json({ actor: (req as any).internalBypassActor ?? null });
      });

      // Signature was for /api/v1/slots but hitting /api/v1/bookings
      await request(appB)
        .get("/api/v1/bookings")
        .set("x-bypass-actor", ACTOR)
        .set("x-bypass-ts", String(ts))
        .set("x-bypass-sig", sig)
        .expect(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration test: bypass middleware + rate limiter
// ---------------------------------------------------------------------------

// Moved top-level import outside describe block
const { createAuthAwareRateLimiter } = await import("../rateLimiter.js");
const { _setTestMock, _resetStore } = await import("../rateLimitStore.js");

describe("fairQueueBypass + createAuthAwareRateLimiter integration", () => {
  // Mock ioredis before importing the rate limiter
  const storage = new Map<string, string>();
  const mockRedis: any = {
    multi: jest.fn<any>().mockReturnThis(),
    incr: jest.fn<any>().mockImplementation(function (this: any, key: string) {
      const current = parseInt(storage.get(key) ?? "0", 10);
      storage.set(key, (current + 1).toString());
      return this;
    }),
    expire: jest.fn<any>().mockReturnThis(),
    exec: jest.fn<any>().mockImplementation(async function (this: any) {
      const lastIncr = this.incr.mock.calls[this.incr.mock.calls.length - 1];
      const key = (lastIncr as string[])[0];
      const val = parseInt(storage.get(key) ?? "1", 10);
      return [[null, val]];
    }),
    decr: jest.fn<any>().mockImplementation(async (key: string) => {
      const current = parseInt(storage.get(key) ?? "0", 10);
      storage.set(key, (current - 1).toString());
      return current - 1;
    }),
    del: jest.fn<any>().mockImplementation(async (key: string) => {
      storage.delete(key);
      return 1;
    }),
    on: jest.fn<any>().mockReturnThis(),
    quit: jest.fn<any>().mockResolvedValue("OK"),
  };

  jest.unstable_mockModule("ioredis", () => ({
    Redis: jest.fn<any>().mockImplementation(() => mockRedis),
    default: jest.fn<any>().mockImplementation(() => mockRedis),
  }));



  let app: express.Express;
  const WINDOW_MS = 60_000;
  const LIMIT = 2;

  beforeAll(() => {
    _setTestMock(true);
  });

  afterAll(() => {
    _setTestMock(false);
    _resetStore();
  });

  beforeEach(() => {
    storage.clear();
    jest.clearAllMocks();
    _resetStore();

    app = express();
    app.use(express.json());

    // Force rate limiting in tests (override default test-env skip)
    app.use((req: any, _res: Response, next: NextFunction) => {
      req._skipRateLimit = false;
      next();
    });

    // Mount bypass middleware BEFORE rate limiter
    app.use(fairQueueBypass(SECRET, PREV_SECRET, TOLERANCE_MS));

    const limiter = createAuthAwareRateLimiter(WINDOW_MS, LIMIT);

    app.get("/api/v1/slots", limiter, (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    });
  });

  it("bypasses the rate limiter for validated internal requests", async () => {
    // Exhaust the limit for anonymous requests
    await request(app).get("/api/v1/slots").expect(200);
    await request(app).get("/api/v1/slots").expect(200);
    // Third request without bypass should be rate-limited
    await request(app).get("/api/v1/slots").expect(429);

    // Now use the bypass — should still get 200 even though limit is exceeded
    const ts = nowTs();
    const sig = makeSignature(ACTOR, "/api/v1/slots", ts, SECRET);

    const res = await request(app)
      .get("/api/v1/slots")
      .set("x-bypass-actor", ACTOR)
      .set("x-bypass-ts", String(ts))
      .set("x-bypass-sig", sig)
      .expect(200);

    expect(res.body.success).toBe(true);
  });

  it("applies the rate limiter normally when no bypass headers are sent", async () => {
    await request(app).get("/api/v1/slots").expect(200);
    await request(app).get("/api/v1/slots").expect(200);
    await request(app).get("/api/v1/slots").expect(429);
  });

  it("applies the rate limiter when bypass signature is invalid", async () => {
    // Exhaust limit
    await request(app).get("/api/v1/slots").expect(200);
    await request(app).get("/api/v1/slots").expect(200);

    const ts = nowTs();
    const badSig = makeSignature(ACTOR, "/api/v1/slots", ts, "wrong-secret");

    // Invalid bypass → 403 from the bypass middleware itself (before rate limiter)
    await request(app)
      .get("/api/v1/slots")
      .set("x-bypass-actor", ACTOR)
      .set("x-bypass-ts", String(ts))
      .set("x-bypass-sig", badSig)
      .expect(403);
  });

  it("grants bypass when signed with the previous (rotating) secret", async () => {
    // Exhaust limit
    await request(app).get("/api/v1/slots").expect(200);
    await request(app).get("/api/v1/slots").expect(200);
    await request(app).get("/api/v1/slots").expect(429);

    const ts = nowTs();
    const sig = makeSignature(ACTOR, "/api/v1/slots", ts, PREV_SECRET);

    const res = await request(app)
      .get("/api/v1/slots")
      .set("x-bypass-actor", ACTOR)
      .set("x-bypass-ts", String(ts))
      .set("x-bypass-sig", sig)
      .expect(200);

    expect(res.body.success).toBe(true);
  });
});
