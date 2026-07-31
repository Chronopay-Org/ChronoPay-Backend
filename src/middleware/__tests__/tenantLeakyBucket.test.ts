/**
 * Tests for the per-tenant leaky-bucket rate limiter.
 *
 * Edge cases required by the issue are covered explicitly:
 *   - burst then sustained traffic ("burst then sustained")
 *   - tenant identity changing between requests ("tenant switch mid-connection")
 *   - slow/failing Redis ("Redis latency spike") → bounded wait + fail-open
 */

import { jest } from "@jest/globals";
import request from "supertest";
import express, { type Request, type Response } from "express";

const {
  decideLeakyBucket,
  bucketTtlSeconds,
  sanitizeTenantIdentifier,
  resolveTenantIdentity,
  createTenantLeakyBucketRateLimiter,
  InMemoryLeakyBucketStore,
  RedisLeakyBucketStore,
  LeakyBucketRedisTimeoutError,
  LEAKY_BUCKET_LUA,
} = await import("../tenantLeakyBucket.js");

const T0 = 1_700_000_000_000;

/** Build an express app with a fake auth layer + the limiter under test. */
function buildApp(
  limiter: express.RequestHandler,
  handlerResponses?: (req: Request, res: Response) => void,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: express.NextFunction) => {
    const userId = req.header("x-user-id");
    const tenantId = req.header("x-auth-tenant-id"); // trusted auth-context claim (set by upstream auth)
    if (userId || tenantId) {
       
      (req as any).auth = { userId, tenantId, role: "customer", claims: {} };
    }
    next();
  });
  app.get(
    "/search",
    limiter,
    handlerResponses ?? ((_req: Request, res: Response) => res.status(200).json({ success: true })),
  );
  return app;
}

describe("decideLeakyBucket (pure transition)", () => {
  const base = { ratePerSecond: 60, capacity: 120 };

  it("admits the first request on a fresh bucket", () => {
    const d = decideLeakyBucket(0, T0, { ...base, nowMs: T0 });
    expect(d).toEqual({ allowed: true, level: 1, retryAfterMs: 0 });
  });

  it("admits at the exact capacity boundary", () => {
    const d = decideLeakyBucket(119, T0, { ...base, nowMs: T0 });
    expect(d.allowed).toBe(true);
    expect(d.level).toBe(120);
  });

  it("rejects when the bucket is full and reports exact retry-after", () => {
    // level 120, 1 more unit needs 1 token to drain: 1/60rps = 16.67ms → 17ms
    const d = decideLeakyBucket(120, T0, { ...base, nowMs: T0 });
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(17);
    expect(d.level).toBeCloseTo(120);
  });

  it("drains at the leak rate over elapsed time", () => {
    // 1000ms at 60 rps drains 60 tokens: 120 → 60, request admitted at 61.
    const d = decideLeakyBucket(120, T0, { ...base, nowMs: T0 + 1000 });
    expect(d.allowed).toBe(true);
    expect(d.level).toBeCloseTo(61);
  });

  it("clamps drain at zero for long-idle buckets", () => {
    const d = decideLeakyBucket(120, T0, { ...base, nowMs: T0 + 60_000 });
    expect(d.allowed).toBe(true);
    expect(d.level).toBe(1);
  });

  it("never grows the bucket on clock skew (negative elapsed)", () => {
    // now goes backwards relative to the stored timestamp (cross-instance skew)
    const d = decideLeakyBucket(120, T0 + 5000, { ...base, nowMs: T0 });
    expect(d.allowed).toBe(false); // NOT rejected-by-growth; level stays 120
    expect(d.level).toBe(120);
  });

  it("rejects non-positive rate/capacity", () => {
    expect(() => decideLeakyBucket(0, T0, { ratePerSecond: 0, capacity: 10, nowMs: T0 })).toThrow();
    expect(() => decideLeakyBucket(0, T0, { ratePerSecond: 60, capacity: -1, nowMs: T0 })).toThrow();
    expect(() =>
      decideLeakyBucket(0, T0, { ratePerSecond: Number.NaN, capacity: 10, nowMs: T0 }),
    ).toThrow();
  });
});

describe("bucketTtlSeconds", () => {
  it("covers two full drain periods plus slack", () => {
    expect(bucketTtlSeconds(60, 120)).toBe(5); // ceil(120/60*2)+1
  });
  it("never returns less than 1", () => {
    expect(bucketTtlSeconds(1000, 1)).toBeGreaterThanOrEqual(1);
  });
});

describe("sanitizeTenantIdentifier", () => {
  it("passes safe identifiers through unchanged", () => {
    expect(sanitizeTenantIdentifier("tenant-42_x.y")).toBe("tenant-42_x.y");
  });

  it("hashes identifiers containing key-injection characters", () => {
    const out = sanitizeTenantIdentifier("tenant:vip");
    expect(out.startsWith("h:")).toBe(true);
    expect(out).toHaveLength(2 + 32);
    expect(out).not.toContain(":vip");
  });

  it("hashes overlong identifiers", () => {
    const out = sanitizeTenantIdentifier("x".repeat(500));
    expect(out.startsWith("h:")).toBe(true);
  });

  it("hashes empty/whitespace identifiers", () => {
    expect(sanitizeTenantIdentifier("   ")).toMatch(/^h:/);
  });
});

describe("resolveTenantIdentity", () => {
  function reqWith(overrides: Record<string, unknown>): express.Request {
    return {
      auth: overrides.auth,
      user: overrides.user,
      apiKeyId: overrides.apiKeyId,
      headers: (overrides.headers ?? {}) as Record<string, string>,
      socket: { remoteAddress: overrides.ip ?? "10.0.0.1" },
       
    } as any;
  }

  it("prefers the trusted auth tenant claim over everything else", () => {
    const identity = resolveTenantIdentity(
      reqWith({ auth: { tenantId: "acme", userId: "u1" }, apiKeyId: "k9" }),
    );
    expect(identity.key).toBe("rlb:bookings:search:tenant:acme");
    expect(identity.label).toBe("acme");
  });

  it("falls back to the authenticated user id as the tenant boundary", () => {
    const identity = resolveTenantIdentity(reqWith({ auth: { userId: "user-123" } }));
    expect(identity.key).toBe("rlb:bookings:search:user:user-123");
  });

  it("supports JWT user claims (sub / tenantId)", () => {
    expect(resolveTenantIdentity(reqWith({ user: { sub: "u-sub" } })).key).toBe(
      "rlb:bookings:search:user:u-sub",
    );
    expect(resolveTenantIdentity(reqWith({ user: { tenantId: "t-1", sub: "u" } })).key).toBe(
      "rlb:bookings:search:tenant:t-1",
    );
  });

  it("hashes API keys (never stores the raw key)", () => {
    const identity = resolveTenantIdentity(reqWith({ apiKeyId: "super-secret-key" }));
    expect(identity.key).toMatch(/^rlb:bookings:search:apiKey:[0-9a-f]{32}$/);
    expect(identity.key).not.toContain("super-secret-key");
  });

  it("never trusts a raw x-tenant-id request header (evasion prevention)", () => {
    const identity = resolveTenantIdentity(
      reqWith({ headers: { "x-tenant-id": "vip" }, ip: "10.0.0.9" }),
    );
    // Without auth context the header is ignored → hashed-IP bucket.
    expect(identity.key).toMatch(/^rlb:bookings:search:ip:/);
    expect(identity.key).not.toContain("vip");
  });

  it("hashes IPs so raw addresses never land in Redis keys", () => {
    const identity = resolveTenantIdentity(reqWith({ ip: "203.0.113.7" }));
    expect(identity.key).toMatch(/^rlb:bookings:search:ip:[0-9a-f]{32}$/);
    expect(identity.key).not.toContain("203.0.113.7");
  });

  it("falls back to a stable anonymous bucket when no IP is discoverable", () => {
     
    const identity = resolveTenantIdentity({ headers: {} } as any);
    expect(identity.key).toMatch(/^rlb:bookings:search:ip:[0-9a-f]{32}$/);
    expect(identity.label).toMatch(/^ip:[0-9a-f]{16}$/);
  });
});

describe("createTenantLeakyBucketRateLimiter (middleware, deterministic clock)", () => {
  let now: number;
  let store: InstanceType<typeof InMemoryLeakyBucketStore>;
  let limiter: express.RequestHandler;
  let app: express.Express;

  beforeEach(() => {
    now = T0;
    store = new InMemoryLeakyBucketStore(() => now);
    limiter = createTenantLeakyBucketRateLimiter({ ratePerSecond: 60, capacity: 120, store });
    app = buildApp(limiter);
  });

  it("constructor validates its parameters", () => {
    expect(() => createTenantLeakyBucketRateLimiter({ ratePerSecond: 0 })).toThrow();
    expect(() => createTenantLeakyBucketRateLimiter({ capacity: 0 })).toThrow();
    expect(() => createTenantLeakyBucketRateLimiter({ amount: 0 })).toThrow();
  });

  it("admits traffic under the burst ceiling and sets X-RateLimit headers", async () => {
    const res = await request(app).get("/search").set("x-user-id", "alice").expect(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("120");
    expect(res.headers["x-ratelimit-remaining"]).toBe("119");
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    expect(res.headers["retry-after"]).toBeUndefined();
  });

  it("burst then sustained: 120-request burst passes, 121st is throttled, bucket refills at 60 rps", async () => {
    const headers = { "x-user-id": "noisy" };

    // 1) Full burst is absorbed (capacity = 120).
    for (let i = 0; i < 120; i++) {
      await request(app).get("/search").set(headers).expect(200);
    }

    // 2) Burst exhausted → immediate retry is throttled with a precise Retry-After.
    const denied = await request(app).get("/search").set(headers).expect(429);
    expect(denied.headers["retry-after"]).toBe("1");
    expect(denied.headers["x-ratelimit-remaining"]).toBe("0");
    expect(denied.body).toMatchObject({ success: false, retryAfter: 1 });

    // 3) 100ms later exactly 6 tokens have drained (60 rps): 6 pass, 7th throttled.
    now += 100;
    for (let i = 0; i < 6; i++) {
      await request(app).get("/search").set(headers).expect(200);
    }
    await request(app).get("/search").set(headers).expect(429);

    // 4) After a full second of drain, exactly 60 succeed → sustained 60 rps.
    now += 1000;
    for (let i = 0; i < 60; i++) {
      await request(app).get("/search").set(headers).expect(200);
    }
    await request(app).get("/search").set(headers).expect(429);

    // 5) Steady state: another second, exactly 60 more — never more than the leak rate.
    now += 1000;
    for (let i = 0; i < 60; i++) {
      await request(app).get("/search").set(headers).expect(200);
    }
    await request(app).get("/search").set(headers).expect(429);
  });

  it("noisy tenant cannot starve other tenants (per-tenant isolation)", async () => {
    // Tenant A exhausts its entire bucket.
    for (let i = 0; i < 121; i++) {
      await request(app).get("/search").set("x-user-id", "tenant-a");
    }
    await request(app).get("/search").set("x-user-id", "tenant-a").expect(429);

    // Tenant B's bucket is untouched.
    const res = await request(app).get("/search").set("x-user-id", "tenant-b").expect(200);
    expect(res.headers["x-ratelimit-remaining"]).toBe("119");
  });

  it("tenant switch mid-connection charges the correct bucket each request", async () => {
    // Simulate a shared/proxied keep-alive connection alternating identities.
    await request(app).get("/search").set("x-user-id", "first").expect(200);
    await request(app).get("/search").set("x-user-id", "second").expect(200);
    await request(app).get("/search").set("x-user-id", "first").expect(200);

    // Each identity owns an independent bucket with independent levels.
    expect(store.size).toBe(2);
    const r = await request(app).get("/search").set("x-user-id", "first").expect(200);
    expect(r.headers["x-ratelimit-remaining"]).toBe("117"); // first: 3 requests total
    const r2 = await request(app).get("/search").set("x-user-id", "second").expect(200);
    expect(r2.headers["x-ratelimit-remaining"]).toBe("118"); // second: 2 requests total
  });

  it("trusted tenant claims override the per-user bucket", async () => {
    // Same user, two different trusted tenant claims → two distinct buckets.
    await request(app)
      .get("/search")
      .set("x-user-id", "shared-user")
      .set("x-auth-tenant-id", "tenant-x")
      .expect(200);
    const res = await request(app)
      .get("/search")
      .set("x-user-id", "shared-user")
      .set("x-auth-tenant-id", "tenant-y")
      .expect(200);
    expect(res.headers["x-ratelimit-remaining"]).toBe("119");
  });

  it("anonymous callers fall back to a shared hashed-IP bucket which can be throttled", async () => {
    const anon = createTenantLeakyBucketRateLimiter({ ratePerSecond: 60, capacity: 3, store });
    const anonApp = buildApp(anon);
    await request(anonApp).get("/search").expect(200);
    await request(anonApp).get("/search").expect(200);
    await request(anonApp).get("/search").expect(200);
    await request(anonApp).get("/search").expect(429);
    // ... while an authenticated tenant is unaffected.
    await request(anonApp).get("/search").set("x-user-id", "vip").expect(200);
  });

  it("works with zero options (all defaults from config)", async () => {
    const defaultLimiter = createTenantLeakyBucketRateLimiter();
    const defaultApp = buildApp(defaultLimiter);
    await request(defaultApp).get("/search").set("x-user-id", "cfg-user").expect(200);
  });

  it("fails open when the store throws", async () => {
    const failingStore = {
      consume: jest.fn<any, any>().mockRejectedValue(new Error("redis connection lost")),
    };
    const open = createTenantLeakyBucketRateLimiter({
      ratePerSecond: 60,
      capacity: 120,
       
      store: failingStore as any,
    });
    const openApp = buildApp(open);
    const res = await request(openApp).get("/search").set("x-user-id", "u").expect(200);
    expect(res.body.success).toBe(true);
    expect(failingStore.consume).toHaveBeenCalled();
  });

  it("fails open even when the store rejects with a non-Error value", async () => {
    const weirdStore = {
      consume: jest.fn<any, any>().mockImplementation(() => Promise.reject("redis said no")),
    };
     
    const open = createTenantLeakyBucketRateLimiter({ ratePerSecond: 60, capacity: 120, store: weirdStore as any });
    const openApp = buildApp(open);
    await request(openApp).get("/search").set("x-user-id", "u2").expect(200);
  });
});

describe("RedisLeakyBucketStore (unit, fake client)", () => {
   
  const makeClient = (overrides: Record<string, unknown> = {}): any => ({
    evalsha: jest.fn<any, any>().mockResolvedValue([1, 0, 1999]),
    eval: jest.fn<any, any>().mockResolvedValue([1, 0, 1999]),
    script: jest.fn<any, any>().mockResolvedValue(["cached"]),
    quit: jest.fn<any, any>().mockResolvedValue("OK"),
    on: jest.fn(),
    ...overrides,
  });

  it("uses EVALSHA with key, clock, rate, capacity, amount and TTL args", async () => {
    const client = makeClient();
    const store = new RedisLeakyBucketStore(client, 250);
    const decision = await store.consume("rlb:bookings:search:user:u1", {
      ratePerSecond: 60,
      capacity: 120,
    });

    expect(decision).toEqual({ allowed: true, retryAfterMs: 0, level: 1.999 });
    expect(client.evalsha).toHaveBeenCalledTimes(1);
    const [sha, numKeys, key, nowMs, rate, capacity, amount, ttl] = client.evalsha.mock.calls[0] as [
      string, number, string, number, number, number, number, number,
    ];
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(numKeys).toBe(1);
    expect(key).toBe("rlb:bookings:search:user:u1");
    expect(Number.isFinite(nowMs)).toBe(true);
    expect(rate).toBe(60);
    expect(capacity).toBe(120);
    expect(amount).toBe(1);
    expect(ttl).toBe(5); // bucketTtlSeconds(60, 120)
    expect(client.eval).not.toHaveBeenCalled();
  });

  it("falls back to EVAL on NOSCRIPT and parses throttled responses", async () => {
    const client = makeClient({
      evalsha: jest.fn<any, any>().mockRejectedValue(new Error("NOSCRIPT No matching script. Please use EVAL.")),
      eval: jest.fn<any, any>().mockResolvedValue([0, 17, 120000]),
    });
    const store = new RedisLeakyBucketStore(client, 250);
    const decision = await store.consume("k", { ratePerSecond: 60, capacity: 120, amount: 1 });

    expect(client.evalsha).toHaveBeenCalledTimes(1);
    expect(client.eval).toHaveBeenCalledTimes(1);
    const [scriptArg, numKeys, key] = client.eval.mock.calls[0] as [string, number, string];
    expect(scriptArg).toBe(LEAKY_BUCKET_LUA);
    expect(numKeys).toBe(1);
    expect(key).toBe("k");
    expect(decision).toEqual({ allowed: false, retryAfterMs: 17, level: 120 });
  });

  it("propagates non-NOSCRIPT Redis errors", async () => {
    const client = makeClient({
      evalsha: jest.fn<any, any>().mockRejectedValue(new Error("READONLY replica")),
    });
    const store = new RedisLeakyBucketStore(client, 250);
    await expect(store.consume("k", { ratePerSecond: 60, capacity: 120 })).rejects.toThrow("READONLY");
    expect(client.eval).not.toHaveBeenCalled();
  });

  it("enforces the timeout on a latency spike instead of hanging", async () => {
    const client = makeClient({
      // Simulates a Redis that never answers within the budget.
      evalsha: jest.fn<any, any>().mockImplementation(() => new Promise(() => {})),
    });
    const store = new RedisLeakyBucketStore(client, 40);
    const started = Date.now();
    await expect(store.consume("k", { ratePerSecond: 60, capacity: 120 })).rejects.toBeInstanceOf(
      LeakyBucketRedisTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("tolerates degenerate Lua reply tuples", async () => {
    const client = makeClient({
      evalsha: jest.fn<any, any>().mockResolvedValue([1, null, undefined]),
    });
    const store = new RedisLeakyBucketStore(client, 250);
    const decision = await store.consume("k", { ratePerSecond: 60, capacity: 120 });
    expect(decision).toEqual({ allowed: true, retryAfterMs: 0, level: 0 });
  });

  it("rejects an invalid timeout", () => {
    expect(() => new RedisLeakyBucketStore(makeClient(), 0)).toThrow();
    expect(() => new RedisLeakyBucketStore(makeClient(), Number.NaN)).toThrow();
  });
});

describe("middleware + RedisLeakyBucketStore: Redis latency spike end-to-end", () => {
  it("a slow store fails open within the timeout and the response completes", async () => {
    const slowClient = {
      evalsha: jest.fn<any, any>().mockImplementation(() => new Promise(() => {})),
      eval: jest.fn<any, any>().mockResolvedValue([1, 0, 1000]),
      script: jest.fn(),
      quit: jest.fn(),
      on: jest.fn(),
    };
     
    const store = new RedisLeakyBucketStore(slowClient as any, 50);
    const limiter = createTenantLeakyBucketRateLimiter({ ratePerSecond: 60, capacity: 120, store });
    const app = buildApp(limiter);

    const started = Date.now();
    const res = await request(app).get("/search").set("x-user-id", "spike-victim").expect(200);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.body.success).toBe(true);
  });
});

describe("InMemoryLeakyBucketStore", () => {
  it("tracks state per key and resets", async () => {
    const store = new InMemoryLeakyBucketStore(() => T0);
    await store.consume("a", { ratePerSecond: 1, capacity: 1 });
    expect(store.size).toBe(1);
    await store.consume("b", { ratePerSecond: 1, capacity: 1 });
    expect(store.size).toBe(2);
    store.reset();
    expect(store.size).toBe(0);
  });

  it("expires idle buckets after their TTL (mirrors Redis EXPIRE), keeps live ones", async () => {
    let now = T0;
    const store = new InMemoryLeakyBucketStore(() => now);
    const params = { ratePerSecond: 1, capacity: 1 }; // ttl = 3s
    await store.consume("stale", params);
    await store.consume("live", params);
    expect(store.size).toBe(2);

    now += 4_000; // past the 3s TTL of both entries
    await store.consume("live", params); // refreshes 'live', prunes 'stale'
    expect(store.size).toBe(1);
  });
});
