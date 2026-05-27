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
    retryStrategy: (times) => {
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
function createRedisStore() {
  const client = createRedisClient();

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
        // results is an array of command results; first is the incremented count
        const count = results?.[0] as number;
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
        callback?.();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        callback?.(error);
      }
    },
  };
}

/**
 * Shared store instance.
 * In test mode: uses a dummy no-op store.
 * In production: uses Redis.
 */
export const rateLimitRedisStore = (() => {
  if (process.env.NODE_ENV === 'test') {
    return createNoopStore();
  }
  return createRedisStore();
})();


