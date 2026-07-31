/**
 * Unit tests for the scheduler pause flag helpers in src/redis.ts.
 *
 * Runs under NODE_ENV=test, so `getRedisClient()` returns whatever fake we
 * inject with `setRedisClient()`. Injecting `null` simulates "Redis down".
 */
import { jest } from "@jest/globals";
import {
  SCHEDULER_PAUSED_KEY,
  RedisUnavailableError,
  pauseScheduler,
  resumeScheduler,
  readSchedulerPauseState,
  setRedisClient,
  isRedisReady,
  closeRedisClient,
  type RedisLike,
} from "../redis.js";

function makeFakeRedis(overrides: Partial<RedisLike> = {}) {
  const store = new Map<string, string>();
  const client: RedisLike & { store: Map<string, string> } = {
    store,
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    del: async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    },
    ping: async () => "PONG",
    quit: async () => "OK",
    ...overrides,
  };
  return client;
}

describe("scheduler redis flag", () => {
  afterEach(() => {
    setRedisClient(null);
    jest.restoreAllMocks();
  });

  it("exposes the canonical redis key", () => {
    expect(SCHEDULER_PAUSED_KEY).toBe("scheduler:paused");
  });

  it("pauseScheduler stores a structured paused=1 payload and returns state", async () => {
    const redis = makeFakeRedis();
    setRedisClient(redis);

    const state = await pauseScheduler({ reason: "db incident", initiatedBy: "alice" });

    expect(state).toMatchObject({
      paused: true,
      reason: "db incident",
      initiatedBy: "alice",
    });
    expect(typeof state.pausedAt).toBe("string");

    const stored = JSON.parse(redis.store.get(SCHEDULER_PAUSED_KEY)!);
    expect(stored).toMatchObject({
      paused: 1,
      reason: "db incident",
      initiated_by: "alice",
    });
    expect(typeof stored.paused_at).toBe("string");
  });

  it("readSchedulerPauseState reflects a pause and its metadata", async () => {
    const redis = makeFakeRedis();
    setRedisClient(redis);

    await pauseScheduler({ reason: "spike", initiatedBy: "bob" });
    const state = await readSchedulerPauseState();

    expect(state).toMatchObject({
      paused: true,
      reason: "spike",
      initiatedBy: "bob",
    });
  });

  it("resumeScheduler clears the flag (pause then immediate resume)", async () => {
    const redis = makeFakeRedis();
    setRedisClient(redis);

    await pauseScheduler({ reason: "spike", initiatedBy: "bob" });
    expect((await readSchedulerPauseState()).paused).toBe(true);

    const resumed = await resumeScheduler({ initiatedBy: "bob" });
    expect(resumed).toEqual({ paused: false, initiatedBy: "bob" });
    expect(redis.store.has(SCHEDULER_PAUSED_KEY)).toBe(false);
    expect(await readSchedulerPauseState()).toEqual({ paused: false });
  });

  it("readSchedulerPauseState returns { paused: false } when the key is absent", async () => {
    setRedisClient(makeFakeRedis());
    expect(await readSchedulerPauseState()).toEqual({ paused: false });
  });

  it("tolerates a bare '1' legacy value", async () => {
    const redis = makeFakeRedis();
    redis.store.set(SCHEDULER_PAUSED_KEY, "1");
    setRedisClient(redis);
    expect(await readSchedulerPauseState()).toEqual({ paused: true });
  });

  it("tolerates a JSON-quoted '1' primitive value", async () => {
    const redis = makeFakeRedis();
    redis.store.set(SCHEDULER_PAUSED_KEY, JSON.stringify("1")); // '"1"'
    setRedisClient(redis);
    expect(await readSchedulerPauseState()).toEqual({ paused: true });
  });

  it("treats a boolean-true paused field as paused", async () => {
    const redis = makeFakeRedis();
    redis.store.set(SCHEDULER_PAUSED_KEY, JSON.stringify({ paused: true, reason: "r" }));
    setRedisClient(redis);
    expect(await readSchedulerPauseState()).toMatchObject({ paused: true, reason: "r" });
  });

  it("tolerates a bare non-'1' legacy value as not paused", async () => {
    const redis = makeFakeRedis();
    redis.store.set(SCHEDULER_PAUSED_KEY, "nope");
    setRedisClient(redis);
    expect(await readSchedulerPauseState()).toEqual({ paused: false });
  });

  it("treats a JSON payload with paused=0 as not paused", async () => {
    const redis = makeFakeRedis();
    redis.store.set(SCHEDULER_PAUSED_KEY, JSON.stringify({ paused: 0 }));
    setRedisClient(redis);
    expect(await readSchedulerPauseState()).toEqual({ paused: false });
  });

  it("accepts a string '1' paused field and camelCase metadata keys", async () => {
    const redis = makeFakeRedis();
    redis.store.set(
      SCHEDULER_PAUSED_KEY,
      JSON.stringify({ paused: "1", reason: "r", initiatedBy: "carol", pausedAt: "t" }),
    );
    setRedisClient(redis);
    expect(await readSchedulerPauseState()).toEqual({
      paused: true,
      reason: "r",
      initiatedBy: "carol",
      pausedAt: "t",
    });
  });

  describe("Redis unavailable (fail-open contract source)", () => {
    it("pauseScheduler throws RedisUnavailableError when client is null", async () => {
      setRedisClient(null);
      await expect(pauseScheduler({ reason: "x", initiatedBy: "y" })).rejects.toBeInstanceOf(
        RedisUnavailableError,
      );
    });

    it("resumeScheduler throws RedisUnavailableError when client is null", async () => {
      setRedisClient(null);
      await expect(resumeScheduler({ initiatedBy: "y" })).rejects.toBeInstanceOf(
        RedisUnavailableError,
      );
    });

    it("readSchedulerPauseState throws RedisUnavailableError when client is null", async () => {
      setRedisClient(null);
      await expect(readSchedulerPauseState()).rejects.toBeInstanceOf(RedisUnavailableError);
    });

    it("wraps a set() failure as RedisUnavailableError", async () => {
      setRedisClient(
        makeFakeRedis({
          set: async () => {
            throw new Error("connection reset");
          },
        }),
      );
      await expect(pauseScheduler({ reason: "x", initiatedBy: "y" })).rejects.toBeInstanceOf(
        RedisUnavailableError,
      );
    });

    it("wraps a del() failure as RedisUnavailableError", async () => {
      setRedisClient(
        makeFakeRedis({
          del: async () => {
            throw new Error("connection reset");
          },
        }),
      );
      await expect(resumeScheduler({ initiatedBy: "y" })).rejects.toBeInstanceOf(
        RedisUnavailableError,
      );
    });

    it("wraps a get() failure as RedisUnavailableError", async () => {
      setRedisClient(
        makeFakeRedis({
          get: async () => {
            throw new Error("connection reset");
          },
        }),
      );
      await expect(readSchedulerPauseState()).rejects.toBeInstanceOf(RedisUnavailableError);
    });
  });

  it("isRedisReady tracks the injected client", () => {
    setRedisClient(makeFakeRedis());
    expect(isRedisReady()).toBe(true);
    setRedisClient(null);
    expect(isRedisReady()).toBe(false);
  });

  it("closeRedisClient quits and resets readiness (idempotent)", async () => {
    const quit = jest.fn<() => Promise<string>>().mockResolvedValue("OK");
    setRedisClient(makeFakeRedis({ quit }));
    await closeRedisClient();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(isRedisReady()).toBe(false);
    // Idempotent: second call is a no-op.
    await expect(closeRedisClient()).resolves.toBeUndefined();
  });
});
