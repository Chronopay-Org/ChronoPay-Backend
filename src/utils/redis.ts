// Singleton instance using `any` to bypass complex TS Namespace conflicts with ioredis types
let redisClient: any = null;
let _ready = false;

/** Returns true once the client has emitted the "ready" event. */
export function isRedisReady(): boolean {
  return _ready;
}

/** Reset the singleton — used in tests to get a fresh in-memory store. */
export const resetRedisClient = (): void => {
  redisClient = null;
};

export const getRedisClient = (): any => {
  if (!redisClient) {
    if (process.env.NODE_ENV === "test") {
      const memoryStore = new Map<string, { value: string; expiresAt: number }>();

      redisClient = {
        ping: async () => "PONG",
        on: () => {},
        get: async (key: string) => memoryStore.get(key) || null,
        set: async (key: string, val: string, ex?: string, time?: number, nx?: string) => {
          if (nx === "NX" && memoryStore.has(key)) return null;
          memoryStore.set(key, {
            value: val,
            expiresAt: Date.now() + ttlSeconds * 1000,
          });
          return "OK";
        },
        quit: async () => {
          memoryStore.clear();
          return "OK";
        },
      };
      _ready = true;
      return redisClient;
    }

    // Dynamically import ioredis only in non-test environments
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Redis } = require("ioredis");
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times: number) => {
        if (times > MAX_RETRY_ATTEMPTS) {
          logError("[redis] Max reconnect attempts reached — giving up", {
            attempts: times,
            url: safeUrl,
          });
          return null;
        }
        const delay = Math.min(times * 100, MAX_RETRY_DELAY_MS);
        logWarn("[redis] Reconnecting", { attempt: times, delayMs: delay, url: safeUrl });
        return delay;
      },
    });

    redisClient.on("connect", () => {
      logInfo("[redis] TCP connection established", { url: safeUrl });
    });

    redisClient.on("ready", () => {
      _ready = true;
      logInfo("[redis] Ready — accepting commands", { url: safeUrl });
    });

    redisClient.on("error", (err: Error) => {
      logError("[redis] Connection error", { message: err.message, url: safeUrl });
    });

    redisClient.on("close", () => {
      _ready = false;
      logWarn("[redis] Connection closed", { url: safeUrl });
    });

    redisClient.on("end", () => {
      _ready = false;
      logWarn("[redis] Connection ended — no further reconnects", { url: safeUrl });
    });
  }

  return redisClient;
};

/**
 * Gracefully close the connection.  Idempotent — safe to call multiple times.
 * Call this from SIGTERM/SIGINT handlers before process.exit().
 */
export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    const closing = redisClient;
    redisClient = null;
    _ready = false;
    await closing.quit();
    logInfo("[redis] Connection closed gracefully");
  }
}
