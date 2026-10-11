/**
 * Shared Redis store for rate limiting.
 *
 * Implements the `store` interface required by `express-rate-limit`.
 * Uses ioredis for all operations. In test environment, provides a no-op
 * in-memory store that satisfies the interface without requiring Redis.
 *
 * Key namespace: "rl:" prefix to avoid collisions with other Redis usage.
 */

import { Redis } from "ioredis";
import { logger } from "../utils/logger.js";

/** @internal - Exposed for testing only. */
export let _isTestMock = false;
export function _setTestMock(val: boolean) {
  _isTestMock = val;
}
export let _testClient: any = null;
export function _setTestClient(client: any) {
  _testClient = client;
}

/**
 * Dummy store for test mode (rate limiting is skipped anyway).
 */
function createNoopStore() {
  return {
    init(_options?: any) {
      // noop
    },
    async incr(
      _key: string,
      _expiryTime?: number,
      _callback?: (err: Error | null, count?: number) => void,
    ) {
      _callback?.(null, 1);
      return 1;
    },
    async decrease(_key: string, _callback?: (err: Error | null, count?: number) => void) {
      _callback?.(null, 0);
      return 0;
    },
    async resetKey(_key: string, _callback?: (err: Error | null) => void) {
      _callback?.(null);
    },
    async resetAll(): Promise<void> {
      // noop
    },
    async increment(_key: string) {
      return { totalHits: 1, resetTime: undefined };
    },
    async decrement(_key: string) {
      return;
    },
    async close(): Promise<void> {
      // noop
    },
  };
}

/**
 * Create a Redis client configured for rate limiting.
 * Uses lazyConnect to defer connection until first use.
 */
function createRedisClient(): Redis {
  if (_testClient) return _testClient;
  const client = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: null, // No limit on retries for commands
    enableReadyCheck: true,
    lazyConnect: true,
    showFriendlyErrorStack: process.env.NODE_ENV !== "production",
    retryStrategy: (times) => {
      // In test mode, don't retry to avoid hanging tests
      if (process.env.NODE_ENV === "test") return null;
      // Give up after 10 attempts, delay capped at 2s
      if (times > 10) return null;
      return Math.min(times * 100, 2000);
    },
  });

  return client;
}

/**
 * Store implementation using ioredis.
 *
 * The Store interface requires:
 *   - incr(key, expiryTime?, callback?) -> number
 *   - decrease(key, callback?) -> number
 *   - resetKey(key, callback?) -> void
 *
 * `expiryTime` is an absolute Unix timestamp in milliseconds.
 */
// @ts-expect-error - Auto-fixed by script
export interface RateLimitStore extends ReturnType<typeof createRedisStore> {
  close?: () => Promise<void>;
}

function createRedisStore() {
  const client = createRedisClient();

  // Handle errors to prevent process crashes and hanging tests
  client.on("error", (err) => {
    if (process.env.NODE_ENV !== "test") {
      logger.error({ err }, "Redis RateLimitStore Error");
    }
  });

  let windowMs = 60_000;

  return {
    init(options: any) {
      if (options?.windowMs) {
        windowMs = options.windowMs;
      }
    },

    async increment(key: string): Promise<{ totalHits: number; resetTime: Date | undefined }> {
      try {
        const multi = client.multi();
        multi.incr(key);
        const ttlSec = Math.ceil(windowMs / 1000);
        if (ttlSec > 0) {
          multi.expire(key, ttlSec);
        }
        const results = await multi.exec();
        const count = (results?.[0]?.[1] as number) ?? 1;
        return { totalHits: count, resetTime: new Date(Date.now() + windowMs) };
      } catch (_err) {
        return { totalHits: 1, resetTime: undefined };
      }
    },

    async decrement(key: string): Promise<void> {
      try {
        await client.decr(key);
      } catch (_err) {
        // ignore
      }
    },

    async incr(key: string, expiryTimeOrCallback?: any, maybeCallback?: any): Promise<number> {
      const callback =
        typeof expiryTimeOrCallback === "function" ? expiryTimeOrCallback : maybeCallback;
      const expiryTime =
        typeof expiryTimeOrCallback === "number" ? expiryTimeOrCallback : undefined;
      try {
        const multi = client.multi();
        multi.incr(key);
        if (expiryTime) {
          const ttlSec = Math.ceil((expiryTime - Date.now()) / 1000);
          if (ttlSec > 0) {
            multi.expire(key, ttlSec);
          }
        }
        const results = await multi.exec();
        const count = (results?.[0]?.[1] as number) ?? 1;
        callback?.(null, count);
        return count;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        callback?.(error);
        return 0;
      }
    },

    async decrease(
      key: string,
      callback?: (err: Error | null, count?: number) => void,
    ): Promise<number> {
      try {
        const count = await client.decr(key);
        callback?.(null, count);
        return count;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        callback?.(error);
        return 0;
      }
    },

    async resetKey(key: string, callback?: (err: Error | null) => void): Promise<void> {
      try {
        await client.del(key);
        callback?.(null);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        callback?.(error);
      }
    },

    async close(): Promise<void> {
      await client.quit();
    },
  };
}

/**
 * Shared store instance.
 * In test mode: uses a dummy no-op store.
 * In production: uses Redis.
 *
 * @internal - Exposed for testing only.
 */
export function _createStore(env: string = process.env.NODE_ENV || "development"): RateLimitStore {
  if (env === "test" && !_isTestMock) {
    return createNoopStore();
  }
  return createRedisStore();
}

let memoizedStore: RateLimitStore | undefined;
export function _resetStore() {
  memoizedStore = undefined;
}

export const rateLimitRedisStore = new Proxy({} as RateLimitStore, {
  get(_target, prop: keyof RateLimitStore) {
    if (!memoizedStore) {
      memoizedStore = _createStore();
    }
    const val = memoizedStore[prop];
    return typeof val === "function" ? val.bind(memoizedStore) : val;
  },
});
