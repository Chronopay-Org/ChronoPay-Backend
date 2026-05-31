/**
 * Shared Redis store for rate limiting.
 *
 * Implements the `store` interface required by `express-rate-limit`.
 * Uses ioredis for all operations. In test environment, provides a no-op
 * in-memory store that satisfies the interface without requiring Redis.
 *
 * Key namespace: "rl:" prefix to avoid collisions with other Redis usage.
 */

import { Redis } from 'ioredis';

/** @internal - Exposed for testing only. */
export let _isTestMock = false;
export function _setTestMock(val: boolean) { _isTestMock = val; }

/**
 * Dummy store for test mode (rate limiting is skipped anyway).
 */
function createNoopStore() {
  return {
    async incr(_key: string, _expiryTime?: number, _callback?: (err: Error | null, count?: number) => void) {
      _callback?.(null, 1);
      return 1;
    },
    async decrease(_key: string, _callback?: (err: Error | null, count?: number) => void) {
      _callback?.(null, 0);
      return 0;
    },
    async resetKey(_key: string, _callback?: (err: Error | null) => void) {
      // @ts-expect-error - Auto-fixed by script
      _callback?.();
    },
  };
}

/**
 * Create a Redis client configured for rate limiting.
 * Uses lazyConnect to defer connection until first use.
 */
function createRedisClient(): Redis {
  const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null, // No limit on retries for commands
    enableReadyCheck: true,
    lazyConnect: true,
    showFriendlyErrorStack: process.env.NODE_ENV !== 'production',
    retryStrategy: (times) => {
      // In test mode, don't retry to avoid hanging tests
      if (process.env.NODE_ENV === 'test') return null;
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
  client.on('error', (err) => {
    if (process.env.NODE_ENV !== 'test') {
      console.error('Redis RateLimitStore Error:', err);
    }
  });

  return {
    async incr(key: string, expiryTime?: number, callback?: (err: Error | null, count?: number) => void): Promise<number> {
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
        // results is an array of [error, result] pairs.
        // The first command was INCR, so its result is at index 0, position 1.
        const count = results?.[0]?.[1] as number;
        callback?.(null, count);
        return count;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        callback?.(error);
        return 0;
      }
    },

    async decrease(key: string, callback?: (err: Error | null, count?: number) => void): Promise<number> {
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
        // @ts-expect-error - Auto-fixed by script
        callback?.();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        callback?.(error);
      }
    },

    async close(): Promise<void> {
      await client.quit();
    }
  };
}

/**
 * Shared store instance.
 * In test mode: uses a dummy no-op store.
 * In production: uses Redis.
 *
 * @internal - Exposed for testing only.
 */
export function _createStore(env: string = process.env.NODE_ENV || 'development'): RateLimitStore {
  if (env === 'test' && !_isTestMock) {
    return createNoopStore();
  }
  return createRedisStore();
}

let memoizedStore: RateLimitStore | undefined;
export function _resetStore() { memoizedStore = undefined; }

export const rateLimitRedisStore = new Proxy({} as RateLimitStore, {
  get(_target, prop: keyof RateLimitStore) {
    if (!memoizedStore) {
      memoizedStore = _createStore();
    }
    const val = memoizedStore[prop];
    return typeof val === 'function' ? val.bind(memoizedStore) : val;
  }
});


