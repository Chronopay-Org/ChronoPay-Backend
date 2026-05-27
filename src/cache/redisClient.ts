/**
 * Redis lifecycle management for the slot cache.
 *
 * Design decisions
 * ────────────────
 * - Single lazy-initialized connection reused across all callers.
 * - Exponential backoff reconnect capped at 2 s; gives up after 10 attempts.
 * - Lifecycle events (connect, ready, error, close) are logged via the
 *   structured logger with the connection URL sanitized — credentials are
 *   stripped before any log line is emitted.
 * - `isRedisReady()` exposes a readiness flag so health checks and startup
 *   probes can gate on actual Redis availability.
 * - In test environments the singleton starts as null; tests inject fakes via
 *   `setRedisClient()`.
 * - `closeRedisClient()` is idempotent and safe to call from SIGTERM/SIGINT
 *   handlers.
 */

import {createRequire} from "module";


export const SLOT_CACHE_TTL_SECONDS = parseInt(
  process.env.REDIS_SLOT_TTL_SECONDS ?? "60",
  10,
);

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const require = createRequire(import.meta.url);

/**
 * The minimal Redis surface the rest of the application uses.
 * Typed as an interface so tests can inject fakes without needing ioredis.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    exMode: "EX",
    ttl: number,
    condition?: "NX",
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  quit(): Promise<unknown>;
}

let _client: RedisClient | null = null;
let _ready = false;

/** Returns true once the client has emitted the "ready" event. */
export function isRedisReady(): boolean {
  return _ready;
}

/**
 * Returns the shared Redis client, creating it on first call.
 *
 * In test environments the singleton starts as null; tests that need a real
 * (mock) client should call `setRedisClient()` before the code under test runs.
 */
export function getRedisClient(): RedisClient | null {
  if (process.env.NODE_ENV === "test") {
    return _client;
  }

  if (!_client) {
    const {Redis} = require("ioredis") as {
      Redis: new (
        url: string,
        options: {
          retryStrategy: (times: number) => number;
          maxRetriesPerRequest: number;
          enableReadyCheck: boolean;
          lazyConnect: boolean;
        },
      ) => RedisClient & {
        on(event: "connect" | "error", handler: (...args: unknown[]) => void): void;
      };
    };
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
    redis.on("error", (...args: unknown[]) => {
      const err = args[0];
      const message = err instanceof Error ? err.message : String(err);
      console.error("[redis] Connection error:", message);
    });

    _client = redis;
  }

  return _client;
}

function createLiveClient(): RedisClient {
  // Dynamic import keeps ioredis optional at module load time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Redis } = require("ioredis");

  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const safeUrl = sanitizeRedisUrl(redisUrl);

  const redis = new Redis(redisUrl, {
    retryStrategy: (times: number) => {
      if (times > MAX_RETRY_ATTEMPTS) {
        logError("[redis] Max reconnect attempts reached — giving up", {
          attempts: times,
          url: safeUrl,
        });
        return null; // stop retrying
      }
      const delay = Math.min(times * 100, MAX_RETRY_DELAY_MS);
      logWarn("[redis] Reconnecting", { attempt: times, delayMs: delay, url: safeUrl });
      return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  redis.on("connect", () => {
    logInfo("[redis] TCP connection established", { url: safeUrl });
  });

  redis.on("ready", () => {
    _ready = true;
    logInfo("[redis] Ready — accepting commands", { url: safeUrl });
  });

  redis.on("error", (err: Error) => {
    logError("[redis] Connection error", { message: err.message, url: safeUrl });
  });

  redis.on("close", () => {
    _ready = false;
    logWarn("[redis] Connection closed", { url: safeUrl });
  });

  redis.on("reconnecting", (delay: number) => {
    logWarn("[redis] Reconnecting", { delayMs: delay, url: safeUrl });
  });

  redis.on("end", () => {
    _ready = false;
    logWarn("[redis] Connection ended — no further reconnects", { url: safeUrl });
  });

  return redis;
}

/**
 * Replace the active client — used by tests to inject a mock.
 * Pass `null` to reset back to "no client".
 */
export function setRedisClient(client: RedisClient | null): void {
  _client = client;
  _ready = client !== null;
}

/**
 * Gracefully close the connection.  Idempotent — safe to call multiple times.
 * Call this from SIGTERM/SIGINT handlers before process.exit().
 */
export async function closeRedisClient(): Promise<void> {
  if (_client) {
    const closing = _client;
    _client = null;
    _ready = false;
    await closing.quit();
    logInfo("[redis] Connection closed gracefully");
  }
}
