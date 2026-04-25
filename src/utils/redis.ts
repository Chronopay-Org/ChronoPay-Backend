// Singleton instance using `any` to bypass complex TS Namespace conflicts with ioredis types
let redisClient: any = null;

/** Reset the singleton — used in tests to get a fresh in-memory store. */
export const resetRedisClient = (): void => {
  redisClient = null;
};

export const getRedisClient = (): any => {
  if (!redisClient) {
    if (process.env.NODE_ENV === "test") {
      const memoryStore = new Map<string, string>();
      // Internal test double to instantly resolve tests without tricky ESM Jest mocks
      redisClient = {
        ping: async () => "PONG",
        on: () => {},
        get: async (key: string) => memoryStore.get(key) || null,
        set: async (key: string, val: string, ex?: string, time?: number, nx?: string) => {
          if (nx === "NX" && memoryStore.has(key)) return null;
          memoryStore.set(key, val);
          return "OK";
        }
      };
      return redisClient;
    }

    // Dynamically import ioredis only in non-test environments
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Redis } = require("ioredis");
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times: number) => {
        return Math.min(times * 100, 3000);
      },
    });

    redisClient.on("error", (err: Error) => {
      console.error("[Redis] Connection Error:", err.message);
    });

    redisClient.on("connect", () => {
      console.log("[Redis] Connected successfully.");
    });
  }

  return redisClient;
};
