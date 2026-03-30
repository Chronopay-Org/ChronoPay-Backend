/**
 *
 * Unit tests for src/cache/slotCache.ts
 */

import { jest } from "@jest/globals";

import {
  getCachedSlots,
  setCachedSlots,
  invalidateSlotsCache,
  SLOT_CACHE_KEYS,
  type Slot,
} from "../cache/slotCache.js";

import {
  setRedisClient,
  SLOT_CACHE_TTL_SECONDS,
  type RedisClient,
} from "../cache/redisClient.js";

// ─── Mock factory ─────────────────────────────────────────────────────────────

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

// ─── Test Data ────────────────────────────────────────────────────────────────

const SAMPLE_SLOTS: Slot[] = [
  {
    id: 1,
    professional: "Dr. Smith",
    startTime: "2024-01-01T09:00:00Z",
    endTime: "2024-01-01T09:30:00Z",
  },
  {
    id: 2,
    professional: "Dr. Jones",
    startTime: "2024-01-01T10:00:00Z",
    endTime: "2024-01-01T10:30:00Z",
  },
];

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  setRedisClient(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// getCachedSlots
// ─────────────────────────────────────────────────────────────────────────────

describe("getCachedSlots", () => {
  it("returns parsed slots on cache HIT", async () => {
    const redis = makeMockRedis({
      get: jest
        .fn<RedisClient["get"]>()
        .mockResolvedValue(JSON.stringify(SAMPLE_SLOTS)),
    });

    setRedisClient(redis);

    const result = await getCachedSlots();

    expect(redis.get).toHaveBeenCalledWith(SLOT_CACHE_KEYS.all);
    expect(result).toEqual(SAMPLE_SLOTS);
  });

  it("returns null on cache MISS (redis returns null)", async () => {
    const redis = makeMockRedis({
      get: jest.fn<RedisClient["get"]>().mockResolvedValue(null),
    });

    setRedisClient(redis);

    const result = await getCachedSlots();

    expect(result).toBeNull();
  });

  it("returns null when no Redis client is configured", async () => {
    setRedisClient(null);

    const result = await getCachedSlots();

    expect(result).toBeNull();
  });

  it("returns null and logs a warning when Redis throws", async () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const redis = makeMockRedis({
      get: jest
        .fn<RedisClient["get"]>()
        .mockRejectedValue(new Error("ECONNREFUSED")),
    });

    setRedisClient(redis);

    const result = await getCachedSlots();

    expect(result).toBeNull();

    expect(consoleSpy).toHaveBeenCalledWith(
      "[slotCache] getCachedSlots error:",
      "ECONNREFUSED",
    );

    consoleSpy.mockRestore();
  });

  it("returns null and logs a warning when stored JSON is malformed", async () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const redis = makeMockRedis({
      get: jest
        .fn<RedisClient["get"]>()
        .mockResolvedValue("this is not json {{{"),
    });

    setRedisClient(redis);

    const result = await getCachedSlots();

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setCachedSlots
// ─────────────────────────────────────────────────────────────────────────────

describe("setCachedSlots", () => {
  it("serialises slots and calls redis.set with the correct key and TTL", async () => {
    const redis = makeMockRedis();
    setRedisClient(redis);

    await setCachedSlots(SAMPLE_SLOTS);

    expect(redis.set).toHaveBeenCalledWith(
      SLOT_CACHE_KEYS.all,
      JSON.stringify(SAMPLE_SLOTS),
      "EX",
      SLOT_CACHE_TTL_SECONDS,
    );
  });

  it("does nothing when no Redis client is configured", async () => {
    setRedisClient(null);

    await expect(setCachedSlots(SAMPLE_SLOTS)).resolves.toBeUndefined();
  });

  it("swallows Redis errors and logs a warning", async () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const redis = makeMockRedis({
      set: jest
        .fn<RedisClient["set"]>()
        .mockRejectedValue(new Error("OOM")),
    });

    setRedisClient(redis);

    await expect(setCachedSlots(SAMPLE_SLOTS)).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      "[slotCache] setCachedSlots error:",
      "OOM",
    );

    consoleSpy.mockRestore();
  });

  it("correctly serialises an empty slot array", async () => {
    const redis = makeMockRedis();
    setRedisClient(redis);

    await setCachedSlots([]);

    expect(redis.set).toHaveBeenCalledWith(
      SLOT_CACHE_KEYS.all,
      "[]",
      "EX",
      SLOT_CACHE_TTL_SECONDS,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invalidateSlotsCache
// ─────────────────────────────────────────────────────────────────────────────

describe("invalidateSlotsCache", () => {
  it("calls redis.del with the correct key", async () => {
    const redis = makeMockRedis();
    setRedisClient(redis);

    await invalidateSlotsCache();

    expect(redis.del).toHaveBeenCalledWith(SLOT_CACHE_KEYS.all);
  });

  it("does nothing when no Redis client is configured", async () => {
    setRedisClient(null);

    await expect(invalidateSlotsCache()).resolves.toBeUndefined();
  });

  it("swallows Redis errors and logs a warning", async () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const redis = makeMockRedis({
      del: jest
        .fn<RedisClient["del"]>()
        .mockRejectedValue(new Error("READONLY")),
    });

    setRedisClient(redis);

    await expect(invalidateSlotsCache()).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      "[slotCache] invalidateSlotsCache error:",
      "READONLY",
    );

    consoleSpy.mockRestore();
  });
});