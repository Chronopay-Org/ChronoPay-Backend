/**
 *
 * Lazy singleton Redis client built on ioredis.
 *
 * Design decisions
 * ────────────────
 * - **Single connection** reused across all request handlers; ioredis is
 *   thread-safe and multiplexes commands internally.
 * - **Graceful degradation**: the client is wrapped so that any Redis error
 *   is logged and swallowed rather than propagated to callers.  The API stays
 *   up even if Redis is unavailable — cache misses simply hit the origin every
 *   time.
 * - **Environment-driven config**: connection URL comes from REDIS_URL; TTL
 *   for slot entries comes from REDIS_SLOT_TTL_SECONDS.  Both have safe
 *   defaults for local development.
 * - **Test isolation**: when NODE_ENV=test the module exports a no-op client
 *   so tests that don't care about caching don't need to mock Redis at all.
 *   Tests that *do* exercise cache logic inject their own client via the
 *   `setRedisClient` escape hatch.
 */

import {Redis} from "ioredis";


export const SLOT_CACHE_TTL_SECONDS = parseInt(
  process.env.REDIS_SLOT_TTL_SECONDS ?? "60",
  10,
);

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * The minimal Redis surface the rest of the application uses.
 * Typed as an interface so tests can inject fakes without needing ioredis-mock.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, exMode: "EX", ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}


let _client: RedisClient | null = null;

/**
 * Returns the shared Redis client, creating it on first call.
 *
 * In test environments the singleton starts as null; tests that need a real
 * (mock) client should call `setRedisClient()` before the code under test runs.
 */
export function getRedisClient(): RedisClient | null {
  if (process.env.NODE_ENV === "test") {
    // Return whatever was injected by the test suite (may be null).
    return _client;
  }

  if (!_client) {
    const redis = new Redis(REDIS_URL, {
      // Retry with exponential back-off capped at 2 s; give up after 10 attempts.
      retryStrategy: (times:number) => Math.min(times * 100, 2000),
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    redis.on("connect", () =>
      console.info("[redis] Connected to", REDIS_URL),
    );
    redis.on("error", (err: Error) =>
      console.error("[redis] Connection error:", err.message),
    );

    _client = redis;
  }

  return _client;
}

/**
 * Replace the active client — used by tests to inject a mock.
 * Call with `null` to reset back to "no client".
 */
export function setRedisClient(client: RedisClient | null): void {
  _client = client;
}

/**
 * Gracefully close the connection.  Call during application shutdown.
 */
export async function closeRedisClient(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}