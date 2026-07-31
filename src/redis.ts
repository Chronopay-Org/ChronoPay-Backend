/**
 * @file src/redis.ts
 *
 * Shared Redis access plus the platform "scheduler pause" flag used to freeze
 * new booking-intent creation during an incident.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Why this lives here
 * ────────────────────────────────────────────────────────────────────────────
 * The incident kill-switch has to be reachable from two independent call sites:
 *
 *   1. The admin control-plane route (`src/routes/admin/scheduler.ts`) that
 *      *writes* the flag (pause / resume).
 *   2. The data-plane guard middleware (`src/middleware/schedulerGate.ts`) that
 *      *reads* the flag on every booking-intent create request.
 *
 * Keeping the flag semantics in one module guarantees both sides agree on the
 * Redis key, the value encoding, and the fail-open contract.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Fail-open contract
 * ────────────────────────────────────────────────────────────────────────────
 * The pause flag is a *safety* mechanism, not a correctness one. If Redis is
 * unreachable we must NOT wedge the whole booking funnel shut on top of an
 * unrelated Redis outage. Reads therefore surface a distinguishable
 * `RedisUnavailableError` so the guard can fail *open* (allow traffic) while
 * logging a warning, whereas an explicit paused flag fails *closed* (503).
 */

import { createRequire } from "module";
import { logger } from "./utils/logger.js";

const require = createRequire(import.meta.url);
/* istanbul ignore next -- deployment-env fallback; the test env always sets REDIS_URL */
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * Minimal Redis surface this module depends on. Declared as an interface so
 * tests can inject a fake without pulling in ioredis.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): unknown;
}

let _client: RedisLike | null = null;
let _ready = false;

/** Returns true once the client has emitted the "ready" event. */
export function isRedisReady(): boolean {
  return _ready;
}

/**
 * Replace the active client. Used by tests to inject a fake (or `null` to
 * simulate "Redis unavailable").
 */
export function setRedisClient(client: RedisLike | null): void {
  _client = client;
  _ready = client !== null;
}

/**
 * Returns the shared Redis client, creating it lazily on first use.
 *
 * In `NODE_ENV=test` the singleton starts as `null`; tests inject a fake via
 * `setRedisClient()`. Returning `null` (rather than throwing) lets callers
 * decide how to degrade.
 */
export function getRedisClient(): RedisLike | null {
  if (process.env.NODE_ENV === "test") {
    return _client;
  }

  /* istanbul ignore next -- real ioredis network construction; not exercisable
     under the jest ESM runner, which maps `ioredis` to an ESM-only mock. Mirrors
     the established pattern in src/cache/redisClient.ts. */
  if (!_client) {
    const { Redis } = require("ioredis") as {
      Redis: new (url: string, options: Record<string, unknown>) => RedisLike;
    };

    const redis = new Redis(REDIS_URL, {
      // Exponential back-off capped at 2s; give up after a few attempts so a
      // dead Redis doesn't hold requests hostage — the guard fails open anyway.
      retryStrategy: (times: number) => Math.min(times * 100, 2000),
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    redis.on?.("connect", () => logger.info({ url: REDIS_URL }, "redis connected"));
    redis.on?.("ready", () => {
      _ready = true;
      logger.info({ url: REDIS_URL }, "redis ready");
    });
    redis.on?.("error", (...args: unknown[]) => logger.error({ err: args[0] }, "redis error"));
    redis.on?.("close", () => {
      _ready = false;
    });

    _client = redis;
  }

  return _client;
}

/**
 * Gracefully close the connection. Idempotent — safe to call multiple times.
 */
export async function closeRedisClient(): Promise<void> {
  if (_client) {
    const closing = _client;
    _client = null;
    _ready = false;
    await closing.quit();
    logger.info("redis connection closed gracefully");
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Scheduler pause flag
// ────────────────────────────────────────────────────────────────────────────

/** Redis key holding the platform-wide scheduler pause flag. */
export const SCHEDULER_PAUSED_KEY = "scheduler:paused";

/**
 * Thrown when the pause flag cannot be read/written because Redis is
 * unreachable. Callers use this to decide between fail-open (guard) and a
 * 503 (control-plane write).
 */
export class RedisUnavailableError extends Error {
  public readonly code = "REDIS_UNAVAILABLE";
  constructor(message = "Redis is unavailable") {
    super(message);
    this.name = "RedisUnavailableError";
  }
}

/** In-memory view of the pause flag returned to callers. */
export interface SchedulerPauseState {
  paused: boolean;
  reason?: string;
  initiatedBy?: string;
  pausedAt?: string;
}

interface StoredPausePayload {
  paused: 1;
  reason: string;
  initiated_by: string;
  paused_at: string;
}

/**
 * Pause the scheduler platform-wide.
 *
 * Stores `scheduler:paused` as a JSON payload carrying the incident `reason`
 * and the operator who `initiated_by` the pause, so the flag doubles as an
 * audit breadcrumb. The `paused` field is `1`, satisfying the "scheduler:paused=1"
 * contract while still leaving room for structured metadata.
 *
 * @throws {RedisUnavailableError} when Redis cannot be reached.
 */
export async function pauseScheduler(input: {
  reason: string;
  initiatedBy: string;
}): Promise<SchedulerPauseState> {
  const client = getRedisClient();
  if (!client) {
    throw new RedisUnavailableError();
  }

  const pausedAt = new Date().toISOString();
  const payload: StoredPausePayload = {
    paused: 1,
    reason: input.reason,
    initiated_by: input.initiatedBy,
    paused_at: pausedAt,
  };

  try {
    await client.set(SCHEDULER_PAUSED_KEY, JSON.stringify(payload));
  } catch (err) {
    throw new RedisUnavailableError((err as Error)?.message);
  }

  return {
    paused: true,
    reason: input.reason,
    initiatedBy: input.initiatedBy,
    pausedAt,
  };
}

/**
 * Resume the scheduler by clearing the pause flag.
 *
 * Deleting the key (rather than setting `paused=0`) keeps "not paused" as the
 * absence of the key, which is the safest default should the value ever be
 * evicted or lost.
 *
 * @throws {RedisUnavailableError} when Redis cannot be reached.
 */
export async function resumeScheduler(input: {
  initiatedBy: string;
}): Promise<SchedulerPauseState> {
  const client = getRedisClient();
  if (!client) {
    throw new RedisUnavailableError();
  }

  try {
    await client.del(SCHEDULER_PAUSED_KEY);
  } catch (err) {
    throw new RedisUnavailableError((err as Error)?.message);
  }

  return { paused: false, initiatedBy: input.initiatedBy };
}

/**
 * Read the current pause state.
 *
 * Returns `{ paused: false }` when the key is absent. Tolerates both the
 * structured JSON payload and a bare `"1"` legacy value.
 *
 * @throws {RedisUnavailableError} when Redis cannot be reached.
 */
export async function readSchedulerPauseState(): Promise<SchedulerPauseState> {
  const client = getRedisClient();
  if (!client) {
    throw new RedisUnavailableError();
  }

  let raw: string | null;
  try {
    raw = await client.get(SCHEDULER_PAUSED_KEY);
  } catch (err) {
    throw new RedisUnavailableError((err as Error)?.message);
  }

  if (!raw) {
    return { paused: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Non-JSON legacy encoding: a bare "1" means paused.
    return { paused: raw === "1" };
  }

  // Structured payload written by pauseScheduler().
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Partial<StoredPausePayload> & {
      paused?: unknown;
      initiatedBy?: string;
      pausedAt?: string;
    };
    const paused = obj.paused === 1 || obj.paused === "1" || obj.paused === true;
    if (!paused) {
      return { paused: false };
    }
    return {
      paused: true,
      reason: obj.reason,
      initiatedBy: obj.initiated_by ?? obj.initiatedBy,
      pausedAt: obj.paused_at ?? obj.pausedAt,
    };
  }

  // Primitive legacy encoding: JSON.parse("1") === 1, JSON.parse('"1"') === "1".
  return { paused: parsed === 1 || parsed === "1" };
}
