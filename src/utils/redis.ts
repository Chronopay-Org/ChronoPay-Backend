import { Redis } from "ioredis";
import { logger } from "./logger.js";

const MAX_RETRY_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 2_000;

interface MemoryEntry {
  value: string;
  expiresAt?: number;
}

export interface RedisClient {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string | null>;
  set(key: string, value: string, exMode: "EX", time: number, nx?: "NX"): Promise<string | null>;
  del(key: string): Promise<number>;
  quit(): Promise<string>;
}

let redisClient: RedisClient | null = null;
let _ready = false;

function sanitizeRedisUrl(redisUrl: string): string {
  return redisUrl.replace(/\/\/[^/@]*@/, "//***@");
}

/** Returns true once the client has emitted the "ready" event. */
export function isRedisReady(): boolean {
  return _ready;
}

/** Reset the singleton — used in tests to get a fresh in-memory store. */
export const resetRedisClient = (): void => {
  redisClient = null;
  _ready = false;
};

export const getRedisClient = (): RedisClient => {
  if (redisClient) return redisClient;

  if (process.env.NODE_ENV === "test") {
    const memoryStore = new Map<string, MemoryEntry>();

    const getEntry = (key: string): MemoryEntry | undefined => {
      const entry = memoryStore.get(key);
      if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        memoryStore.delete(key);
        return undefined;
      }
      return entry;
    };

    const client: RedisClient = {
      ping: async () => "PONG",
      get: async (key: string) => getEntry(key)?.value ?? null,
      set: async (key: string, value: string, exMode?: "EX", time?: number, nx?: "NX") => {
        if (nx === "NX" && getEntry(key)) return null;

        const expiresAt = exMode === "EX" && time !== undefined
          ? Date.now() + time * 1_000
          : undefined;
        memoryStore.set(key, { value, expiresAt });
        return "OK";
      },
      del: async (key: string) => {
        getEntry(key);
        return memoryStore.delete(key) ? 1 : 0;
      },
      quit: async () => {
        memoryStore.clear();
        _ready = false;
        return "OK";
      },
    };
    redisClient = client;
    _ready = true;
    return client;
  }

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const safeUrl = sanitizeRedisUrl(redisUrl);
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number) => {
      if (times > MAX_RETRY_ATTEMPTS) {
        logger.error(
          { attempts: times, url: safeUrl },
          "[redis] Max reconnect attempts reached — giving up",
        );
        return null;
      }
      const delay = Math.min(times * 100, MAX_RETRY_DELAY_MS);
      logger.warn(
        { attempt: times, delayMs: delay, url: safeUrl },
        "[redis] Reconnecting",
      );
      return delay;
    },
  });

  client.on("connect", () => {
    logger.info({ url: safeUrl }, "[redis] TCP connection established");
  });

  client.on("ready", () => {
    _ready = true;
    logger.info({ url: safeUrl }, "[redis] Ready — accepting commands");
  });

  client.on("error", (err: Error) => {
    logger.error(
      { message: err.message, url: safeUrl },
      "[redis] Connection error",
    );
  });

  client.on("close", () => {
    _ready = false;
    logger.warn({ url: safeUrl }, "[redis] Connection closed");
  });

  client.on("end", () => {
    _ready = false;
    logger.warn(
      { url: safeUrl },
      "[redis] Connection ended — no further reconnects",
    );
  });

  const redisClientAdapter: RedisClient = {
    ping: () => client.ping(),
    get: (key: string) => client.get(key),
    set: (key: string, value: string, exMode?: "EX", time?: number, nx?: "NX") => {
      if (exMode === "EX" && time !== undefined) {
        return nx === "NX"
          ? client.set(key, value, exMode, time, nx)
          : client.set(key, value, exMode, time);
      }
      return client.set(key, value);
    },
    del: (key: string) => client.del(key),
    quit: () => client.quit(),
  };
  redisClient = redisClientAdapter;
  return redisClientAdapter;
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
    logger.info("[redis] Connection closed gracefully");
  }
}
