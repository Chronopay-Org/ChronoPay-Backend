import { jest } from "@jest/globals";
import {
  closeRedisClient,
  getRedisClient,
  setRedisClient,
  type RedisClient,
} from "../../cache/redisClient.js";
import { claimDelivery, dedupKey } from "../reminderDedup.js";
import { RedisCursorStore, cursorKey } from "../escrowCursorStore.js";
import {
  RedisIdempotencyStore,
  idempotencyKey,
} from "../escrowIdempotencyStore.js";

type FakeRedisClient = RedisClient & {
  store: Map<string, string>;
  quit: ReturnType<typeof jest.fn>;
};

function createFakeRedisClient(): FakeRedisClient {
  const store = new Map<string, string>();

  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(
      key: string,
      value: string,
      _exMode?: "EX",
      _ttl?: number,
      condition?: "NX",
    ) {
      if (condition === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
    async keys(pattern: string) {
      const prefix = pattern.replace(/\*$/, "");
      return Array.from(store.keys()).filter((key) => key.startsWith(prefix));
    },
    async ping() {
      return "PONG";
    },
    quit: jest.fn(async () => "OK"),
  };
}

describe("scheduler Redis-backed stores", () => {
  let redis: FakeRedisClient;

  beforeEach(() => {
    redis = createFakeRedisClient();
    setRedisClient(redis);
  });

  afterEach(() => {
    setRedisClient(null);
  });

  it("claims a reminder delivery only once", async () => {
    expect(await claimDelivery(42, 1_000)).toBe(true);
    expect(await claimDelivery(42, 1_000)).toBe(false);
    expect(redis.store.has(dedupKey(42, 1_000))).toBe(true);
  });

  it("stores and advances an escrow cursor in the shared client", async () => {
    const cursor = new RedisCursorStore();

    expect(await cursor.get("listener-a")).toBeNull();
    await cursor.set("listener-a", 7);
    expect(await cursor.get("listener-a")).toBe(7);
    expect(redis.store.get(cursorKey("listener-a"))).toBe("7");

    await expect(cursor.set("listener-a", 6)).rejects.toThrow(/cannot regress/);
  });

  it("claims and releases escrow idempotency keys in the shared client", async () => {
    const store = new RedisIdempotencyStore();

    expect(await store.claim("tx:0")).toBe(true);
    expect(await store.claim("tx:0")).toBe(false);
    expect(redis.store.has(idempotencyKey("tx:0"))).toBe(true);

    await store.release("tx:0");
    expect(await store.claim("tx:0")).toBe(true);
  });

  it("uses the client that closeRedisClient quits on shutdown", async () => {
    await claimDelivery(1, 2);

    await closeRedisClient();

    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(getRedisClient()).toBeNull();
  });

  it("fails explicitly when no Redis client is configured", async () => {
    setRedisClient(null);

    await expect(claimDelivery(1, 2)).rejects.toThrow(/Redis client is not available/);
    await expect(new RedisCursorStore().get("listener-a")).rejects.toThrow(
      /Redis client is not available/,
    );
    await expect(new RedisIdempotencyStore().claim("tx:0")).rejects.toThrow(
      /Redis client is not available/,
    );
  });
});
