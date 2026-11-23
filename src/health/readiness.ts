import type { Pool } from "pg";
import type { RedisClient } from "../cache/redisClient.js";

export interface ReadinessResult {
  db: "ok" | "down";
  redis: "ok" | "down";
}

export interface ReadinessPingers {
  pingDb: () => Promise<boolean>;
  pingRedis: () => Promise<boolean>;
}

export async function checkReadiness(pingers: ReadinessPingers): Promise<ReadinessResult> {
  const [dbOk, redisOk] = await Promise.all([pingers.pingDb(), pingers.pingRedis()]);
  return {
    db: dbOk ? "ok" : "down",
    redis: redisOk ? "ok" : "down",
  };
}

export function checkDb(pool: Pick<Pool, "query"> | null | undefined): Promise<boolean> {
  if (!pool) return Promise.resolve(false);
  return pool
    .query("SELECT 1")
    .then(() => true)
    .catch(() => false);
}

export function checkRedis(client: RedisClient): Promise<boolean> {
  return client
    .ping()
    .then(() => true)
    .catch(() => false);
}
