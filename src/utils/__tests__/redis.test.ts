import { jest } from "@jest/globals";
import { logger } from "../logger.js";

const redisInstances: Array<{
  url: string;
  options: { retryStrategy: (times: number) => number | null };
  listeners: Map<string, (...args: any[]) => void>;
}> = [];

const RedisConstructor = jest.fn<any, any>().mockImplementation((url: string, options: any) => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const client = {
    on: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, listener);
      return client;
    },
    quit: jest.fn<() => Promise<string>>().mockResolvedValue("OK"),
  };
  redisInstances.push({ url, options, listeners });
  return client;
});

jest.unstable_mockModule("ioredis", () => ({
  Redis: RedisConstructor,
  default: RedisConstructor,
}));

const { closeRedisClient, getRedisClient, isRedisReady, resetRedisClient } =
  await import("../redis.js");

describe("utils redis client", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    redisInstances.length = 0;
    resetRedisClient();
  });

  afterEach(async () => {
    await closeRedisClient();
    resetRedisClient();
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it("returns stored values as strings", async () => {
    const redis = getRedisClient();

    await redis.set("redis-test:key", "stored value");

    await expect(redis.get("redis-test:key")).resolves.toBe("stored value");
    await expect(redis.get("redis-test:missing")).resolves.toBeNull();
  });

  it("honors NX when a key already exists", async () => {
    const redis = getRedisClient();

    await expect(redis.set("redis-test:nx", "first", "EX", 60, "NX")).resolves.toBe("OK");
    await expect(redis.set("redis-test:nx", "second", "EX", 60, "NX")).resolves.toBeNull();
    await expect(redis.get("redis-test:nx")).resolves.toBe("first");
  });

  it("expires keys after the supplied EX duration", async () => {
    jest.useFakeTimers();
    const redis = getRedisClient();

    await redis.set("redis-test:ttl", "temporary", "EX", 1);
    jest.advanceTimersByTime(1_001);

    await expect(redis.get("redis-test:ttl")).resolves.toBeNull();
  });

  it("logs sanitized connection failures and stops retrying after the configured limit", () => {
    process.env.NODE_ENV = "development";
    process.env.REDIS_URL = "redis://user:secret@bad-host:6379";
    const warn = jest.spyOn(logger, "warn");
    const error = jest.spyOn(logger, "error");

    getRedisClient();

    const redis = redisInstances[0];
    expect(redis.url).toBe("redis://user:secret@bad-host:6379");
    expect(redis.options.retryStrategy(1)).toBe(100);
    expect(redis.options.retryStrategy(10)).toBe(1_000);
    expect(redis.options.retryStrategy(11)).toBeNull();
    redis.listeners.get("error")?.(new Error("connection refused"));

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ url: "redis://***@bad-host:6379" }),
      "[redis] Reconnecting",
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ url: "redis://***@bad-host:6379" }),
      "[redis] Max reconnect attempts reached — giving up",
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "connection refused",
        url: "redis://***@bad-host:6379",
      }),
      "[redis] Connection error",
    );
    expect(isRedisReady()).toBe(false);
  });
});
