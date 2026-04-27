/**
 *
 * Unit tests for src/cache/slotCache.ts
 */

import { jest } from "@jest/globals";

// Import the actual modules - they will use the test environment's null client by default
import {
  getCachedSlots,
  setCachedSlots,
  invalidateSlotsCache,
  getCachedSlotsPage,
  setCachedSlotsPage,
  SLOT_CACHE_KEYS,
  type Slot,
  type PaginatedSlotsResult,
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
    keys: jest.fn<RedisClient["keys"]>().mockResolvedValue([]),
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

const SAMPLE_PAGINATED_RESULT: PaginatedSlotsResult = {
  slots: SAMPLE_SLOTS,
  page: 1,
  pageSize: 10,
  total: 2,
  totalPages: 1,
};

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  setRedisClient(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// getCachedSlots (legacy)
// ─────────────────────────────────────────────────────────────────────────────

describe("getCachedSlots (legacy)", () => {
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
// setCachedSlots (legacy)
// ─────────────────────────────────────────────────────────────────────────────

describe("setCachedSlots (legacy)", () => {
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
// getCachedSlotsPage (paginated)
// ─────────────────────────────────────────────────────────────────────────────

describe("getCachedSlotsPage", () => {
  it("returns parsed paginated result on cache HIT", async () => {
    const redis = makeMockRedis({
      get: jest
        .fn<RedisClient["get"]>()
        .mockResolvedValue(JSON.stringify(SAMPLE_PAGINATED_RESULT)),
    });

    setRedisClient(redis);

    const result = await getCachedSlotsPage(1);

    expect(redis.get).toHaveBeenCalledWith(SLOT_CACHE_KEYS.page(1));
    expect(result).toEqual(SAMPLE_PAGINATED_RESULT);
  });

  it("returns null on cache MISS", async () => {
    const redis = makeMockRedis({
      get: jest.fn<RedisClient["get"]>().mockResolvedValue(null),
    });

    setRedisClient(redis);

    const result = await getCachedSlotsPage(1);

    expect(result).toBeNull();
  });

  it("returns null when no Redis client is configured", async () => {
    setRedisClient(null);

    const result = await getCachedSlotsPage(1);

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

    const result = await getCachedSlotsPage(1);

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      "[slotCache] getCachedSlotsPage error:",
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

    const result = await getCachedSlotsPage(1);

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it("generates correct cache key for different page numbers", async () => {
    const redis = makeMockRedis({
      get: jest
        .fn<RedisClient["get"]>()
        .mockResolvedValue(JSON.stringify(SAMPLE_PAGINATED_RESULT)),
    });

    setRedisClient(redis);

    await getCachedSlotsPage(1);
    await getCachedSlotsPage(2);
    await getCachedSlotsPage(3);

    expect(redis.get).toHaveBeenNthCalledWith(1, "slots:page:1");
    expect(redis.get).toHaveBeenNthCalledWith(2, "slots:page:2");
    expect(redis.get).toHaveBeenNthCalledWith(3, "slots:page:3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setCachedSlotsPage (paginated)
// ─────────────────────────────────────────────────────────────────────────────

describe("setCachedSlotsPage", () => {
  it("serialises paginated result and calls redis.set with correct key and TTL", async () => {
    const redis = makeMockRedis();
    setRedisClient(redis);

    await setCachedSlotsPage(1, SAMPLE_PAGINATED_RESULT);

    expect(redis.set).toHaveBeenCalledWith(
      SLOT_CACHE_KEYS.page(1),
      JSON.stringify(SAMPLE_PAGINATED_RESULT),
      "EX",
      SLOT_CACHE_TTL_SECONDS,
    );
  });

  it("does nothing when no Redis client is configured", async () => {
    setRedisClient(null);

    await expect(setCachedSlotsPage(1, SAMPLE_PAGINATED_RESULT)).resolves.toBeUndefined();
  });

  it("swallows Redis errors and logs a warning", async () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const redis = makeMockRedis({
      set: jest
        .fn<RedisClient["set"]>()
        .mockRejectedValue(new Error("OOM")),
    });

    setRedisClient(redis);

    await expect(setCachedSlotsPage(1, SAMPLE_PAGINATED_RESULT)).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      "[slotCache] setCachedSlotsPage error:",
      "OOM",
    );

    consoleSpy.mockRestore();
  });

  it("generates correct cache key for different page numbers", async () => {
    const redis = makeMockRedis();
    setRedisClient(redis);

    await setCachedSlotsPage(1, SAMPLE_PAGINATED_RESULT);
    await setCachedSlotsPage(2, SAMPLE_PAGINATED_RESULT);
    await setCachedSlotsPage(3, SAMPLE_PAGINATED_RESULT);

    expect(redis.set).toHaveBeenNthCalledWith(1, "slots:page:1", JSON.stringify(SAMPLE_PAGINATED_RESULT), "EX", SLOT_CACHE_TTL_SECONDS);
    expect(redis.set).toHaveBeenNthCalledWith(2, "slots:page:2", JSON.stringify(SAMPLE_PAGINATED_RESULT), "EX", SLOT_CACHE_TTL_SECONDS);
    expect(redis.set).toHaveBeenNthCalledWith(3, "slots:page:3", JSON.stringify(SAMPLE_PAGINATED_RESULT), "EX", SLOT_CACHE_TTL_SECONDS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invalidateSlotsCache (paginated)
// ─────────────────────────────────────────────────────────────────────────────

describe("invalidateSlotsCache", () => {
  it("deletes all paginated cache keys using pattern matching", async () => {
    const redis = makeMockRedis({
      keys: jest.fn<RedisClient["keys"]>().mockResolvedValue([
        "slots:page:1",
        "slots:page:2",
        "slots:page:3",
      ]),
    });

    setRedisClient(redis);

    await invalidateSlotsCache();

    expect(redis.keys).toHaveBeenCalledWith(SLOT_CACHE_KEYS.pattern);
    expect(redis.del).toHaveBeenCalledWith("slots:page:1");
    expect(redis.del).toHaveBeenCalledWith("slots:page:2");
    expect(redis.del).toHaveBeenCalledWith("slots:page:3");
    expect(redis.del).toHaveBeenCalledWith(SLOT_CACHE_KEYS.all);
  });

  it("handles empty key list gracefully", async () => {
    const redis = makeMockRedis({
      keys: jest.fn<RedisClient["keys"]>().mockResolvedValue([]),
    });

    setRedisClient(redis);

    await invalidateSlotsCache();

    expect(redis.keys).toHaveBeenCalledWith(SLOT_CACHE_KEYS.pattern);
    expect(redis.del).toHaveBeenCalledWith(SLOT_CACHE_KEYS.all);
    expect(redis.del).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no Redis client is configured", async () => {
    setRedisClient(null);

    await expect(invalidateSlotsCache()).resolves.toBeUndefined();
  });

  it("swallows Redis errors and logs a warning", async () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const redis = makeMockRedis({
      keys: jest
        .fn<RedisClient["keys"]>()
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

  it("swallows errors from individual delete operations", async () => {
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const redis = makeMockRedis({
      keys: jest.fn<RedisClient["keys"]>().mockResolvedValue([
        "slots:page:1",
        "slots:page:2",
      ]),
      del: jest
        .fn<RedisClient["del"]>()
        .mockRejectedValueOnce(new Error("DEL_ERROR")),
    });

    setRedisClient(redis);

    await expect(invalidateSlotsCache()).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      "[slotCache] invalidateSlotsCache error:",
      "DEL_ERROR",
    );

    consoleSpy.mockRestore();
  });

  it("deletes legacy key in addition to paginated keys", async () => {
    const redis = makeMockRedis({
      keys: jest.fn<RedisClient["keys"]>().mockResolvedValue(["slots:page:1"]),
    });

    setRedisClient(redis);

    await invalidateSlotsCache();

    expect(redis.del).toHaveBeenCalledWith("slots:page:1");
    expect(redis.del).toHaveBeenCalledWith(SLOT_CACHE_KEYS.all);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security Validation
// ─────────────────────────────────────────────────────────────────────────────

describe("Security: Cache keys do not contain PII", () => {
  it("generates cache keys without PII or user data", () => {
    // Test that cache keys only contain resource names and numeric values
    const key1 = SLOT_CACHE_KEYS.page(1);
    const key2 = SLOT_CACHE_KEYS.page(2);
    const key3 = SLOT_CACHE_KEYS.page(999);
    const allKey = SLOT_CACHE_KEYS.all;
    const pattern = SLOT_CACHE_KEYS.pattern;

    // Verify keys follow safe pattern: resource:page:number
    expect(key1).toBe("slots:page:1");
    expect(key2).toBe("slots:page:2");
    expect(key3).toBe("slots:page:999");
    expect(allKey).toBe("slots:all");
    expect(pattern).toBe("slots:page:*");

    // Verify no email addresses, names, or other PII in keys
    const allKeys = [key1, key2, key3, allKey, pattern];
    for (const key of allKeys) {
      expect(key).not.toMatch(/@/); // No email addresses
      expect(key).not.toMatch(/[A-Z][a-z]+\s+[A-Z][a-z]+/); // No full names
      expect(key).not.toMatch(/user:/); // No user identifiers
      expect(key).not.toMatch(/professional:/); // No professional names
    }
  });

  it("invalidation pattern is hardcoded and safe", () => {
    // The pattern should not include user input
    const pattern = SLOT_CACHE_KEYS.pattern;
    
    // Pattern is a constant string, not dynamically generated
    expect(typeof pattern).toBe("string");
    expect(pattern).toBe("slots:page:*");
    
    // Pattern only matches our own keys
    expect(pattern).toMatch(/^slots:page:\*$/);
  });

  it("cache key function only accepts numeric page numbers", () => {
    // Test that the page function generates safe keys
    const validPages = [1, 2, 3, 10, 100, 1000];
    
    for (const page of validPages) {
      const key = SLOT_CACHE_KEYS.page(page);
      expect(key).toMatch(/^slots:page:\d+$/);
      // Check that the page number portion is numeric
      const pageNum = key.split(":")[2];
      expect(/^\d+$/.test(pageNum)).toBe(true);
    }
  });
});