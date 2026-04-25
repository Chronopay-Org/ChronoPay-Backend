/**
 * Tests for cache stampede protection (single-flight pattern).
 *
 * Covers:
 *  - Concurrent cold-cache requests coalesce into a single origin fetch
 *  - Cache invalidation after mutation causes next fetch to be a MISS
 *  - Metrics counters (hits, misses, stampede-blocked) are incremented correctly
 */

import { jest } from "@jest/globals";
import {
  getOrFetchSlots,
  invalidateSlotsCache,
  _getInFlightCount,
  _clearInFlight,
  type Slot,
} from "../cache/slotCache.js";
import { setRedisClient, type RedisClient } from "../cache/redisClient.js";
import {
  slotCacheHits,
  slotCacheMisses,
  slotCacheStampedeBlocked,
} from "../metrics.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockRedis(
  overrides: Partial<jest.Mocked<RedisClient>> = {},
): jest.Mocked<RedisClient> {
  return {
    get: jest.fn<RedisClient["get"]>().mockResolvedValue(null),
    set: jest.fn<RedisClient["set"]>().mockResolvedValue("OK"),
    del: jest.fn<RedisClient["del"]>().mockResolvedValue(1),
    quit: jest.fn<RedisClient["quit"]>().mockResolvedValue("OK"),
    ...overrides,
  };
}

const SAMPLE_SLOTS: Slot[] = [
  {
    id: 1,
    professional: "Dr. Smith",
    startTime: "2024-01-01T09:00:00Z",
    endTime: "2024-01-01T09:30:00Z",
  },
];

type CounterLike = { hashMap: Record<string, { value: number }> };
function cv(counter: CounterLike): number {
  return counter.hashMap[""]?.value ?? 0;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  _clearInFlight();
  slotCacheHits.reset();
  slotCacheMisses.reset();
  slotCacheStampedeBlocked.reset();
});

afterEach(() => {
  _clearInFlight();
  setRedisClient(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Single-flight: concurrent cold-cache requests
// ─────────────────────────────────────────────────────────────────────────────

describe("getOrFetchSlots — single-flight stampede protection", () => {
  it("calls the fetcher exactly once when N concurrent requests arrive on a cold cache", async () => {
    setRedisClient(makeMockRedis());
    const fetcher = jest.fn<() => Promise<Slot[]>>().mockResolvedValue(SAMPLE_SLOTS);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => getOrFetchSlots(fetcher)),
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const { slots } of results) {
      expect(slots).toEqual(SAMPLE_SLOTS);
    }
  });

  it("first request is MISS, subsequent concurrent ones are STAMPEDE_BLOCKED", async () => {
    // Use a never-resolving fetcher so we can inspect in-flight state
    let resolveOrigin!: (v: Slot[]) => void;
    const originPromise = new Promise<Slot[]>((res) => { resolveOrigin = res; });

    setRedisClient(makeMockRedis());
    const fetcher = jest.fn<() => Promise<Slot[]>>().mockReturnValue(originPromise);

    // Start 3 concurrent calls — none resolved yet
    const p1 = getOrFetchSlots(fetcher);
    const p2 = getOrFetchSlots(fetcher);
    const p3 = getOrFetchSlots(fetcher);

    // Yield to let the async getCachedSlots() calls complete and the
    // in-flight entry to be registered before we check
    await Promise.resolve();
    await Promise.resolve();

    expect(_getInFlightCount()).toBe(1);

    resolveOrigin(SAMPLE_SLOTS);
    const results = await Promise.all([p1, p2, p3]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const statuses = results.map((r) => r.cacheStatus);
    expect(statuses.filter((s) => s === "MISS")).toHaveLength(1);
    expect(statuses.filter((s) => s === "STAMPEDE_BLOCKED")).toHaveLength(2);
  });

  it("cleans up in-flight map after fetch completes", async () => {
    setRedisClient(makeMockRedis());
    const fetcher = jest.fn<() => Promise<Slot[]>>().mockResolvedValue(SAMPLE_SLOTS);

    await getOrFetchSlots(fetcher);

    expect(_getInFlightCount()).toBe(0);
  });

  it("cleans up in-flight map even when the fetcher throws", async () => {
    setRedisClient(makeMockRedis());
    const fetcher = jest.fn<() => Promise<Slot[]>>().mockRejectedValue(new Error("DB down"));

    await expect(getOrFetchSlots(fetcher)).rejects.toThrow("DB down");

    expect(_getInFlightCount()).toBe(0);
  });

  it("returns HIT on a warm cache without calling the fetcher", async () => {
    setRedisClient(
      makeMockRedis({
        get: jest.fn<RedisClient["get"]>().mockResolvedValue(JSON.stringify(SAMPLE_SLOTS)),
      }),
    );
    const fetcher = jest.fn<() => Promise<Slot[]>>();

    const { slots, cacheStatus } = await getOrFetchSlots(fetcher);

    expect(cacheStatus).toBe("HIT");
    expect(slots).toEqual(SAMPLE_SLOTS);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache invalidation after mutation
// ─────────────────────────────────────────────────────────────────────────────

describe("Cache invalidation", () => {
  it("invalidateSlotsCache calls redis.del with the correct key", async () => {
    const redis = makeMockRedis();
    setRedisClient(redis);

    await invalidateSlotsCache();

    expect(redis.del).toHaveBeenCalledWith("slots:all");
  });

  it("after invalidation the next getOrFetchSlots is a MISS", async () => {
    const redis = makeMockRedis();
    setRedisClient(redis);

    const fetcher = jest.fn<() => Promise<Slot[]>>().mockResolvedValue(SAMPLE_SLOTS);

    // First call — MISS, populates cache
    const first = await getOrFetchSlots(fetcher);
    expect(first.cacheStatus).toBe("MISS");

    // Simulate invalidation: del called, next get returns null
    await invalidateSlotsCache();
    redis.get.mockResolvedValue(null);

    // Second call — should be MISS again
    const second = await getOrFetchSlots(fetcher);
    expect(second.cacheStatus).toBe("MISS");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

describe("Cache metrics", () => {
  it("increments hit counter on cache HIT", async () => {
    setRedisClient(
      makeMockRedis({
        get: jest.fn<RedisClient["get"]>().mockResolvedValue(JSON.stringify(SAMPLE_SLOTS)),
      }),
    );
    await getOrFetchSlots(jest.fn<() => Promise<Slot[]>>().mockResolvedValue([]));

    expect(cv(slotCacheHits as unknown as CounterLike)).toBe(1);
    expect(cv(slotCacheMisses as unknown as CounterLike)).toBe(0);
    expect(cv(slotCacheStampedeBlocked as unknown as CounterLike)).toBe(0);
  });

  it("increments miss counter on cache MISS", async () => {
    setRedisClient(makeMockRedis());
    await getOrFetchSlots(jest.fn<() => Promise<Slot[]>>().mockResolvedValue(SAMPLE_SLOTS));

    expect(cv(slotCacheMisses as unknown as CounterLike)).toBe(1);
    expect(cv(slotCacheHits as unknown as CounterLike)).toBe(0);
  });

  it("increments stampede-blocked counter for coalesced requests", async () => {
    let resolveOrigin!: (v: Slot[]) => void;
    const originPromise = new Promise<Slot[]>((res) => { resolveOrigin = res; });

    setRedisClient(makeMockRedis());
    const fetcher = jest.fn<() => Promise<Slot[]>>().mockReturnValue(originPromise);

    const pending = Promise.all([
      getOrFetchSlots(fetcher),
      getOrFetchSlots(fetcher),
      getOrFetchSlots(fetcher),
    ]);

    resolveOrigin(SAMPLE_SLOTS);
    await pending;

    expect(cv(slotCacheMisses as unknown as CounterLike)).toBe(1);
    expect(cv(slotCacheStampedeBlocked as unknown as CounterLike)).toBe(2);
  });
});
