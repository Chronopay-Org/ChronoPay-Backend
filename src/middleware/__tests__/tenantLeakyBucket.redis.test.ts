/**
 * Integration test proving the production Lua script (executed on a real Lua
 * VM via ioredis-mock) behaves *identically* to the pure JS decision engine
 * powering the in-memory store. This guards the invariant that
 * LEAKY_BUCKET_LUA and decideLeakyBucket must never drift apart, without
 * needing a live Redis server in CI.
 *
 * `Date.now` is spied (not fake timers) so the mock's event-loop plumbing
 * keeps working while the store sees a deterministic clock.
 */

import { jest } from "@jest/globals";
import RedisMock from "ioredis-mock";

const {
  RedisLeakyBucketStore,
  InMemoryLeakyBucketStore,
  setTenantLeakyBucketStore,
  resetTenantLeakyBucketStore,
  getTenantLeakyBucketStore,
  _setRedisCtorForTesting,
  createTenantLeakyBucketRateLimiter,
} = await import("../tenantLeakyBucket.js");

const T0 = 1_700_000_000_000;
const PARAMS = { ratePerSecond: 60, capacity: 120 };

describe("Lua script ↔ JS decision engine parity (ioredis-mock Lua VM)", () => {
  let now: number;
  let nowSpy: ReturnType<typeof jest.spyOn>;
  let redisStore: InstanceType<typeof RedisLeakyBucketStore>;
  let memoryStore: InstanceType<typeof InMemoryLeakyBucketStore>;

  async function both(key: string) {
    const fromRedis = await redisStore.consume(key, PARAMS);
    const fromMemory = await memoryStore.consume(key, PARAMS);
    return { fromRedis, fromMemory };
  }

  beforeEach(() => {
    now = T0;
     
    nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now) as any;
     
    redisStore = new RedisLeakyBucketStore(new RedisMock() as any, 1000);
    memoryStore = new InMemoryLeakyBucketStore(() => now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it("120-request burst, throttle, drain and clock-skew behave identically on both stores", async () => {
    const key = "rlb:bookings:search:user:parity";

    // Burst: both stores admit exactly the 120-token burst…
    for (let i = 0; i < 120; i++) {
      const { fromRedis, fromMemory } = await both(key);
      expect(fromRedis).toEqual(fromMemory);
      expect(fromRedis.allowed).toBe(true);
    }

    // …and throttle request 121 with the same retry-after.
    const denied = await both(key);
    expect(denied.fromRedis).toEqual(denied.fromMemory);
    expect(denied.fromRedis).toEqual({ allowed: false, retryAfterMs: 17, level: 120 });

    // Drain 60 tokens over 1 s on both.
    now += 1000;
    const refilled = await both(key);
    expect(refilled.fromRedis).toEqual(refilled.fromMemory);
    expect(refilled.fromRedis.allowed).toBe(true);
    expect(refilled.fromRedis.level).toBeCloseTo(61);

    // Clock skew (now jumps backwards) must not inflate either bucket.
    now -= 30_000;
    const skewed = await both(key);
    expect(skewed.fromRedis).toEqual(skewed.fromMemory);
    expect(skewed.fromRedis.level).toBeGreaterThan(60);
    expect(skewed.fromRedis.level).toBeLessThanOrEqual(120);
  });

  it("keeps tenant buckets independent on Redis too", async () => {
    for (let i = 0; i < 121; i++) await redisStore.consume("rlb:bookings:search:user:a", PARAMS);
    const a = await redisStore.consume("rlb:bookings:search:user:a", PARAMS);
    expect(a.allowed).toBe(false);
    const b = await redisStore.consume("rlb:bookings:search:user:b", PARAMS);
    expect(b).toEqual({ allowed: true, retryAfterMs: 0, level: 1 });
  });

  it("evalsha-first path works: first call triggers NOSCRIPT then caches, subsequent calls are cached", async () => {
    const first = await redisStore.consume("rlb:bookings:search:user:script", PARAMS);
    expect(first.allowed).toBe(true);
    const second = await redisStore.consume("rlb:bookings:search:user:script", PARAMS);
    expect(second).toEqual({ allowed: true, retryAfterMs: 0, level: 2 });
  });
});

describe("store lifecycle", () => {
  afterEach(async () => {
    await resetTenantLeakyBucketStore();
  });

  it("resolves an in-memory store under NODE_ENV=test and accepts injection", () => {
    const resolved = getTenantLeakyBucketStore();
    expect(resolved).toBeInstanceOf(InMemoryLeakyBucketStore);
    const injected = new InMemoryLeakyBucketStore();
    setTenantLeakyBucketStore(injected);
    expect(getTenantLeakyBucketStore()).toBe(injected);
  });

  it("memoizes the default store", () => {
    expect(getTenantLeakyBucketStore()).toBe(getTenantLeakyBucketStore());
  });

  it("builds the production store over an injected Redis ctor (options, error handler, lifecycle)", async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const disconnect = jest.fn<any, any>();
    const ctorCalls: Array<{ url: string; options: Record<string, unknown> }> = [];

    class FakeRedis {
      constructor(url: string, options: Record<string, unknown>) {
        ctorCalls.push({ url, options });
      }
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, handler);
        return this;
      }
      evalsha() {
        return Promise.resolve([1, 0, 1000]);
      }
      eval() {
        return Promise.resolve([1, 0, 1000]);
      }
      script() {
        return Promise.resolve("cached");
      }
      quit() {
        return Promise.resolve("OK");
      }
      disconnect = disconnect;
      status = "ready";
    }

    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "development";
      _setRedisCtorForTesting(FakeRedis as never);
      await resetTenantLeakyBucketStore();

      const store = getTenantLeakyBucketStore();
      expect(store).toBeInstanceOf(RedisLeakyBucketStore);
      expect(ctorCalls).toHaveLength(1);
      expect(ctorCalls[0].url).toMatch(/^redis:\/\//);
      expect(ctorCalls[0].options.lazyConnect).toBe(true);

      // retryStrategy caps backoff and gives up after 10 attempts
      const retry = ctorCalls[0].options.retryStrategy as (n: number) => number | null;
      expect(retry(1)).toBe(100);
      expect(retry(20)).toBeNull();

      // error handler is registered and does not throw
      expect(handlers.has("error")).toBe(true);
      handlers.get("error")?.(new Error("link down"));

      // the store actually works through the fake client (evalsha path)
      const decision = await store.consume("rlb:bookings:search:user:prod", {
        ratePerSecond: 60,
        capacity: 120,
      });
      expect(decision).toEqual({ allowed: true, retryAfterMs: 0, level: 1 });

      // reset tears the cached client down via disconnect()
      await resetTenantLeakyBucketStore();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      _setRedisCtorForTesting(undefined);
      process.env.NODE_ENV = prevEnv;
      await resetTenantLeakyBucketStore();
    }
  });
});

describe("safety net", () => {
  it("an unrecoverable middleware failure still fails open (never crashes the pipeline)", async () => {
    const limiter = createTenantLeakyBucketRateLimiter({
      ratePerSecond: 60,
      capacity: 120,
      store: new InMemoryLeakyBucketStore(),
    });
    // A request object whose every property access explodes — no store error,
    // no res use; the failure escapes the inner try/catch entirely.
    const boobyTrappedReq = new Proxy(
      {},
      {
        get() {
          throw new Error("catastrophic request corruption");
        },
      },
    );
    const res = { setHeader: jest.fn(), status: jest.fn(), json: jest.fn() };
    const next = jest.fn();

     
    limiter(boobyTrappedReq as any, res as any, next as any);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
