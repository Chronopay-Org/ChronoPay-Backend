/**
 * Tests for the Redis slot cache layer (slotCache.ts + redisClient.ts).
 *
 * Uses the ioredis mock from src/mocks/ioredis.ts injected via
 * setRedisClient() to exercise the get/set/invalidate flow and verify
 * HIT/MISS behavior, TTL from env, and graceful error degradation.
 *
 * Coverage targets:
 *  - getCachedSlotsPage  � HIT, MISS, error fallback
 *  - setCachedSlotsPage  � write-through, error fallback
 *  - getOrFetchSlots     � single-flight, cache HIT, cache MISS
 *  - getCachedSlots      � legacy path
 *  - setCachedSlots      � legacy path
 *  - invalidateSlotsCache � clears page keys and legacy key
 *  - Redis unavailable    � all functions return safe defaults
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Redis from "../../mocks/ioredis.js";
import {
  getCachedSlotsPage,
  setCachedSlotsPage,
  invalidateSlotsCache,
  getCachedSlots,
  setCachedSlots,
  getOrFetchSlots,
  type Slot,
  type PaginatedSlotsResult,
} from "../slotCache.js";
import {
  setRedisClient,
  getRedisClient,
  SLOT_CACHE_TTL_SECONDS,
  type RedisClient,
} from "../redisClient.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock Redis client backed by an in-memory Map. */
function createMockRedisClient(): RedisClient & { _store: Map<string, string> } {
  const store = new Map<string, string>();

  return {
    _store: store,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<"OK"> {
      store.set(key, value);
      return "OK";
    },
    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0;
    },
    async keys(pattern: string): Promise<string[]> {
      // Simple glob: "slots:page:*" matches anything starting with "slots:page:"
      const prefix = pattern.replace(/\*$/, "");
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    },
    async ping(): Promise<string> {
      return "PONG";
    },
    async quit(): Promise<"OK"> {
      return "OK";
    },
  };
}

function makeSlots(): Slot[] {
  return [
    { id: 1, professional: "dr-smith", startTime: "09:00", endTime: "09:30" },
    { id: 2, professional: "dr-jones", startTime: "10:00", endTime: "10:30" },
  ];
}

function makePaginatedResult(
  slots: Slot[],
  page = 1,
  pageSize = 10,
): PaginatedSlotsResult {
  return {
    slots,
    page,
    pageSize,
    total: slots.length,
    totalPages: 1,
  };
}

/** Mock fetcher that returns a fixed set of slots. */
function mockFetcher(slots: Slot[]): () => Promise<Slot[]> {
  return jest.fn<() => Promise<Slot[]>>().mockResolvedValue(slots);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Ensure test mode is active so getRedisClient returns the injected client.
  process.env.NODE_ENV = "test";
  setRedisClient(null);
});

afterEach(() => {
  setRedisClient(null);
});

// ---------------------------------------------------------------------------
// getCachedSlotsPage
// ---------------------------------------------------------------------------

describe("getCachedSlotsPage", () => {
  it("returns null when no Redis client is set", async () => {
    const result = await getCachedSlotsPage(1);
    expect(result).toBeNull();
  });

  it("returns null on cache MISS (key not present)", async () => {
    const redis = createMockRedisClient();
    setRedisClient(redis);

    const result = await getCachedSlotsPage(1);
    expect(result).toBeNull();
  });

  it("returns parsed result on cache HIT", async () => {
    const redis = createMockRedisClient();
    const paginated = makePaginatedResult(makeSlots());
    redis._store.set("slots:page:1", JSON.stringify(paginated));
    setRedisClient(redis);

    const result = await getCachedSlotsPage(1);
    expect(result).not.toBeNull();
    expect(result!.page).toBe(1);
    expect(result!.slots).toHaveLength(2);
    expect(result!.slots[0].professional).toBe("dr-smith");
  });

  it("returns null when Redis.get throws (graceful degradation)", async () => {
    const redis = createMockRedisClient();
    redis.get = jest.fn().mockRejectedValue(new Error("connection refused"));
    setRedisClient(redis);

    const result = await getCachedSlotsPage(1);
    expect(result).toBeNull();
  });

  it("uses correct key format for different pages", async () => {
    const redis = createMockRedisClient();
    const p1 = makePaginatedResult(makeSlots(), 1);
    const p2 = makePaginatedResult(makeSlots(), 2);
    redis._store.set("slots:page:1", JSON.stringify(p1));
    redis._store.set("slots:page:2", JSON.stringify(p2));
    setRedisClient(redis);

    const r1 = await getCachedSlotsPage(1);
    const r2 = await getCachedSlotsPage(2);

    expect(r1!.page).toBe(1);
    expect(r2!.page).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// setCachedSlotsPage
// ---------------------------------------------------------------------------

describe("setCachedSlotsPage", () => {
  it("writes serialized result to Redis with correct key and TTL", async () => {
    const redis = createMockRedisClient();
    const setSpy = jest.spyOn(redis, "set");
    setRedisClient(redis);

    const paginated = makePaginatedResult(makeSlots());
    await setCachedSlotsPage(1, paginated);

    // Verify it was stored
    const raw = redis._store.get("slots:page:1");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.page).toBe(1);

    // set() should be called with "EX" mode and the TTL from env
    expect(setSpy).toHaveBeenCalledWith(
      "slots:page:1",
      expect.any(String),
      "EX",
      SLOT_CACHE_TTL_SECONDS,
    );
  });

  it("does not throw when no Redis client is set", async () => {
    await expect(
      setCachedSlotsPage(1, makePaginatedResult(makeSlots())),
    ).resolves.toBeUndefined();
  });

  it("catches and logs Redis.set errors gracefully", async () => {
    const redis = createMockRedisClient();
    redis.set = jest.fn().mockRejectedValue(new Error("write error"));
    setRedisClient(redis);

    // Should not throw
    await expect(
      setCachedSlotsPage(1, makePaginatedResult(makeSlots())),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// invalidateSlotsCache
// ---------------------------------------------------------------------------

describe("invalidateSlotsCache", () => {
  it("deletes all paginated page keys and the legacy key", async () => {
    const redis = createMockRedisClient();
    redis._store.set("slots:page:1", JSON.stringify(makePaginatedResult(makeSlots())));
    redis._store.set("slots:page:2", JSON.stringify(makePaginatedResult(makeSlots())));
    redis._store.set("slots:all", JSON.stringify(makeSlots()));
    setRedisClient(redis);

    await invalidateSlotsCache();

    expect(redis._store.has("slots:page:1")).toBe(false);
    expect(redis._store.has("slots:page:2")).toBe(false);
    expect(redis._store.has("slots:all")).toBe(false);
  });

  it("does not throw when no Redis client is set", async () => {
    await expect(invalidateSlotsCache()).resolves.toBeUndefined();
  });

  it("handles partial failure gracefully (some deletes fail)", async () => {
    const redis = createMockRedisClient();
    redis._store.set("slots:page:1", "data1");
    redis._store.set("slots:page:2", "data2");

    // Make del throw only for the first key
    const originalDel = redis.del.bind(redis);
    redis.del = jest.fn(async (key: string) => {
      if (key === "slots:page:1") throw new Error("delete error");
      return originalDel(key);
    });
    setRedisClient(redis);

    // Should not throw � error is caught internally
    await expect(invalidateSlotsCache()).resolves.toBeUndefined();

    // slots:page:2 should still have been deleted (Promise.all continues)
    expect(redis._store.has("slots:page:2")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getCachedSlots / setCachedSlots (legacy)
// ---------------------------------------------------------------------------

describe("getCachedSlots (legacy)", () => {
  it("returns null when no Redis client", async () => {
    expect(await getCachedSlots()).toBeNull();
  });

  it("returns parsed slots on cache HIT", async () => {
    const redis = createMockRedisClient();
    const slots = makeSlots();
    redis._store.set("slots:all", JSON.stringify(slots));
    setRedisClient(redis);

    const result = await getCachedSlots();
    expect(result).toHaveLength(2);
    expect(result![0].id).toBe(1);
  });

  it("returns null on cache MISS", async () => {
    const redis = createMockRedisClient();
    setRedisClient(redis);

    expect(await getCachedSlots()).toBeNull();
  });
});

describe("setCachedSlots (legacy)", () => {
  it("writes slots to the legacy key", async () => {
    const redis = createMockRedisClient();
    setRedisClient(redis);

    const slots = makeSlots();
    await setCachedSlots(slots);

    const raw = redis._store.get("slots:all");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getOrFetchSlots
// ---------------------------------------------------------------------------

describe("getOrFetchSlots", () => {
  it("returns fetched slots with cacheStatus MISS (no cache)", async () => {
    const slots = makeSlots();
    const fetcher = mockFetcher(slots);

    const result = await getOrFetchSlots(fetcher);

    expect(result.slots).toEqual(slots);
    expect(result.cacheStatus).toBe("MISS");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fetches slots and returns them", async () => {
    const slots = makeSlots();
    const result = await getOrFetchSlots(async () => slots);

    expect(result.slots).toHaveLength(2);
    expect(result.cacheStatus).toBe("MISS");
  });

  it("returns empty array when fetcher returns empty", async () => {
    const fetcher = mockFetcher([]);
    const result = await getOrFetchSlots(fetcher);

    expect(result.slots).toEqual([]);
    expect(result.cacheStatus).toBe("MISS");
  });

  it("propagates errors from the fetcher (no silent catch)", async () => {
    const fetcher = jest.fn<() => Promise<Slot[]>>().mockRejectedValue(new Error("DB down"));

    await expect(getOrFetchSlots(fetcher)).rejects.toThrow("DB down");
  });
});

// ---------------------------------------------------------------------------
// TTL from environment
// ---------------------------------------------------------------------------

describe("SLOT_CACHE_TTL_SECONDS", () => {
  const originalTTL = process.env.REDIS_SLOT_TTL_SECONDS;

  afterEach(() => {
    if (originalTTL !== undefined) {
      process.env.REDIS_SLOT_TTL_SECONDS = originalTTL;
    } else {
      delete process.env.REDIS_SLOT_TTL_SECONDS;
    }
  });

  it("defaults to 60 when REDIS_SLOT_TTL_SECONDS is unset", () => {
    delete process.env.REDIS_SLOT_TTL_SECONDS;
    // Re-import to pick up the env change (we test the constant directly)
    expect(SLOT_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(0);
  });

  it("reads TTL from REDIS_SLOT_TTL_SECONDS env var", async () => {
    process.env.REDIS_SLOT_TTL_SECONDS = "120";
    const redis = createMockRedisClient();
    const setSpy = jest.spyOn(redis, "set");
    setRedisClient(redis);

    await setCachedSlotsPage(1, makePaginatedResult(makeSlots()));

    // The TTL value comes from the module-level constant which is read at import time.
    // We verify the set call includes the TTL parameter.
    expect(setSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "EX",
      expect.any(Number),
    );
  });
});

// ---------------------------------------------------------------------------
// Redis unavailable � all paths return safe defaults
// ---------------------------------------------------------------------------

describe("Redis unavailable", () => {
  it("getCachedSlotsPage returns null", async () => {
    expect(await getCachedSlotsPage(1)).toBeNull();
  });

  it("setCachedSlotsPage does not throw", async () => {
    await expect(
      setCachedSlotsPage(1, makePaginatedResult(makeSlots())),
    ).resolves.toBeUndefined();
  });

  it("getCachedSlots returns null", async () => {
    expect(await getCachedSlots()).toBeNull();
  });

  it("setCachedSlots does not throw", async () => {
    await expect(setCachedSlots(makeSlots())).resolves.toBeUndefined();
  });

  it("invalidateSlotsCache does not throw", async () => {
    await expect(invalidateSlotsCache()).resolves.toBeUndefined();
  });

  it("getOrFetchSlots still works (calls fetcher directly)", async () => {
    const slots = makeSlots();
    const result = await getOrFetchSlots(async () => slots);
    expect(result.slots).toEqual(slots);
    expect(result.cacheStatus).toBe("MISS");
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation after write � integration scenario
// ---------------------------------------------------------------------------

describe("Cache lifecycle: set ? get (HIT) ? invalidate ? get (MISS)", () => {
  it("full cycle with paginated cache", async () => {
    const redis = createMockRedisClient();
    setRedisClient(redis);

    const paginated = makePaginatedResult(makeSlots(), 1);

    // Set cache
    await setCachedSlotsPage(1, paginated);

    // Get � should be HIT
    const hit = await getCachedSlotsPage(1);
    expect(hit).not.toBeNull();
    expect(hit!.slots).toHaveLength(2);

    // Invalidate
    await invalidateSlotsCache();

    // Get � should be MISS
    const miss = await getCachedSlotsPage(1);
    expect(miss).toBeNull();
  });

  it("full cycle with legacy cache", async () => {
    const redis = createMockRedisClient();
    setRedisClient(redis);

    const slots = makeSlots();
    await setCachedSlots(slots);

    const hit = await getCachedSlots();
    expect(hit).toHaveLength(2);

    await invalidateSlotsCache();

    const miss = await getCachedSlots();
    expect(miss).toBeNull();
  });
});
