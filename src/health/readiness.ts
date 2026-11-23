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

const DEFAULT_READINESS_TIMEOUT_MS = 2000;

/**
 * Per-check readiness budget, overridable via READINESS_TIMEOUT_MS.
 * Read on each call so deployments (and tests) can adjust it at runtime.
 */
export function getReadinessTimeoutMs(): number {
  const raw = process.env.READINESS_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_READINESS_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_READINESS_TIMEOUT_MS;
}

/**
 * Reject if `promise` does not settle within `ms`. The timer is cleared as
 * soon as the promise settles so healthy probes leave nothing behind.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number = getReadinessTimeoutMs()): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Readiness check timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Run one pinger, converting sync throws, rejections and timeouts into `false`
 * so a single unhealthy dependency can never hang or 500 the probe.
 */
async function runCheck(pinger: () => Promise<boolean>): Promise<boolean> {
  try {
    return await withTimeout(Promise.resolve(pinger()));
  } catch {
    return false;
  }
}

export async function checkReadiness(pingers: ReadinessPingers): Promise<ReadinessResult> {
  const [dbOk, redisOk] = await Promise.all([
    runCheck(pingers.pingDb),
    runCheck(pingers.pingRedis),
  ]);
  return {
    db: dbOk ? "ok" : "down",
    redis: redisOk ? "ok" : "down",
  };
}

export function checkDb(pool: Pick<Pool, "query"> | null | undefined): Promise<boolean> {
  if (!pool) return Promise.resolve(false);
  try {
    return pool
      .query("SELECT 1")
      .then(() => true)
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function checkRedis(client: RedisClient): Promise<boolean> {
  try {
    return client
      .ping()
      .then(() => true)
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}
