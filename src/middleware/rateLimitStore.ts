/**
 * Shared Redis store for rate limiting.
 *
 * Implements the `store` interface required by `express-rate-limit`.
 * Uses ioredis for all operations. In test environment, provides a no-op
 * in-memory store that satisfies the interface without requiring Redis.
 *
 * Key namespace: "rl:" prefix to avoid collisions with other Redis usage.
 */

import type { Options, Store } from "express-rate-limit";
import { Redis } from "ioredis";
import { logger } from "../utils/logger.js";

/** @internal - Exposed for testing only. */
export let _isTestMock = false;
export function _setTestMock(val: boolean) { _isTestMock = val; }

/**
 * Dummy store for test mode (rate limiting is skipped anyway).
 */
function createNoopStore(): RateLimitStore {
  let windowMs = 60_000;

  return {
    init(options: Options) {
      windowMs = options.windowMs;
    },
    async increment(_key: string) {
      return { totalHits: 1, resetTime: new Date(Date.now() + windowMs) };
    },
    async decrement(_key: string) {},
    async resetKey(_key: string) {},
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
 */
export interface RateLimitStore extends Store {
  close?: () => Promise<void>;
}

function createRedisStore(): RateLimitStore {
  const client = createRedisClient();
  let windowMs = 60_000;

  // Handle errors to prevent process crashes and hanging tests
  client.on('error', (err) => {
    if (process.env.NODE_ENV !== 'test') {
      logger.error({ err }, 'Redis RateLimitStore Error');
    }
  });

  const close = async (): Promise<void> => {
    await client.quit();
  };

  return {
    init(options: Options) {
      windowMs = options.windowMs;
    },

    async increment(key: string) {
      const results = await client
        .multi()
        .incr(key)
        .pexpire(key, windowMs)
        .pttl(key)
        .exec();

      if (!results) {
        throw new Error('Redis rate limit increment returned no transaction results');
      }

      const [incrementError, count] = results[0] ?? [];
      const [ttlError, ttl] = results[2] ?? [];
      if (incrementError) throw incrementError;
      if (ttlError) throw ttlError;
      if (typeof count !== 'number' || typeof ttl !== 'number' || ttl < 0) {
        throw new Error('Redis rate limit increment returned invalid counter or TTL data');
      }

      return { totalHits: count, resetTime: new Date(Date.now() + ttl) };
    },

    async decrement(key: string) {
      await client.decr(key);
    },

    async resetKey(key: string) {
      await client.del(key);
    },

    close,
    shutdown: close,
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
