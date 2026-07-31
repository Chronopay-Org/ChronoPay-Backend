/**
 * @file src/middleware/tenantLeakyBucket.ts
 *
 * Per-tenant leaky-bucket rate limiter for high-traffic search endpoints
 * (initially `/api/v1/bookings/search`).
 *
 * Why this exists
 * ───────────────
 * `createAuthAwareRateLimiter` (express-rate-limit) applies one coarse,
 * fixed-window budget to every authenticated principal. On a search endpoint
 * that is fine for fairness in the small, but a single noisy tenant could
 * burn the shared window and starve every other tenant ("noisy neighbor").
 * This middleware instead maintains an *independent* leaky bucket per
 * tenant, so an abusive tenant only ever degrades its own traffic.
 *
 * Algorithm
 * ─────────
 * Leaky bucket: every accepted request adds `amount` (1) work unit to the
 * bucket; the bucket drains at a constant `ratePerSecond`. A request is
 * admitted while `level + amount <= capacity`. Consequently:
 *   - burst traffic is absorbed up to `capacity` (default 120), and
 *   - sustained throughput converges to `ratePerSecond` (default 60 rps).
 * Rejected requests are answered `429` with a strict `Retry-After` header
 * computed from the exact drain time — never guessed.
 *
 * Atomicity
 * ─────────
 * The read-modify-write of the bucket state executes inside a single Redis
 * Lua script (`LEAKY_BUCKET_LUA`), so concurrent requests from multiple app
 * instances cannot race each other. The script is invoked via EVALSHA with
 * an automatic EVAL fallback on NOSCRIPT (first call / after FLUSH).
 *
 * Failure policy (fail-open, availability-first)
 * ──────────────────────────────────────────────
 * If Redis is unreachable or slower than `redisTimeoutMs`, the limiter
 * *allows* the request and increments `rate_limit_redis_failures_total`.
 * A rate limiter must never take the protected endpoint down with it; the
 * tradeoff is that during a Redis outage protection degrades to the
 * pre-fix (unlimited) behavior. Documented in docs/api/bookings-search.md.
 *
 * Security notes
 * ──────────────
 * - Tenant identity is resolved from *trusted auth context only*
 *   (JWT/req.auth claims, API key). Client-supplied `x-tenant-id` headers
 *   are intentionally NOT trusted, preventing a caller from hopscotching
 *   across tenant buckets to evade the limit.
 * - Identifiers are canonicalized before they are embedded in Redis keys
 *   (strict charset + length cap, otherwise SHA-256), which prevents Redis
 *   key-injection across logical namespaces and bounds Prometheus label
 *   cardinality.
 * - Unauthenticated requests fall back to a SHA-256 hashed IP bucket so
 *   anonymous traffic cannot starve authenticated tenants either.
 * - `Retry-After` is derived from live bucket state, not static.
 *
 * Testability
 * ───────────
 * The store is dependency-injected (`setTenantLeakyBucketStore` /
 * `resetTenantLeakyBucketStore`) and the clock is injectable, so tests can
 * deterministically model bursts, leaks, tenant switches, and Redis
 * latency spikes without sleeping.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { configService } from "../config/config.service.js";
import { rateLimitBucketBurn, rateLimitRedisFailuresTotal } from "../metrics.js";
import { logger } from "../utils/logger.js";

// ─── Decision engine (pure, shared semantics with the Lua script) ───────────

export interface LeakyBucketParams {
  /** Tokens drained per second (sustained throughput). */
  ratePerSecond: number;
  /** Maximum bucket fill level (burst allowance). */
  capacity: number;
  /** Work units this request consumes (normally 1). */
  amount?: number;
  /** Current time in epoch milliseconds (injectable for tests). */
  nowMs: number;
}

export interface LeakyBucketDecision {
  /** Whether the request is admitted. */
  allowed: boolean;
  /** Bucket level after the decision (tokens currently "charged"). */
  level: number;
  /**
   * When rejected: milliseconds until enough capacity has drained for this
   * request to succeed. 0 when allowed.
   */
  retryAfterMs: number;
}

/**
 * Pure leaky-bucket transition. This function is the exact JavaScript mirror
 * of `LEAKY_BUCKET_LUA`; both MUST evolve together so the in-memory store
 * (tests / fallback) and the Redis store behave identically.
 */
export function decideLeakyBucket(
  level: number,
  lastTsMs: number,
  params: LeakyBucketParams,
): LeakyBucketDecision {
  const amount = params.amount ?? 1;
  if (
    !Number.isFinite(params.ratePerSecond) ||
    params.ratePerSecond <= 0 ||
    !Number.isFinite(params.capacity) ||
    params.capacity <= 0
  ) {
    throw new Error("ratePerSecond and capacity must be positive finite numbers");
  }

  // Guard against clock going backwards (cross-instance skew / NTP steps):
  // a negative elapsed would *increase* the level and wrongly reject traffic.
  const elapsedMs = Math.max(0, params.nowMs - lastTsMs);
  const drained = (elapsedMs * params.ratePerSecond) / 1000;
  let newLevel = Math.max(0, level - drained);

  if (newLevel + amount <= params.capacity) {
    newLevel += amount;
    return { allowed: true, level: newLevel, retryAfterMs: 0 };
  }

  const deficit = newLevel + amount - params.capacity;
  const retryAfterMs = Math.ceil((deficit / params.ratePerSecond) * 1000);
  return { allowed: false, level: newLevel, retryAfterMs };
}

/**
 * Redis key TTL for an idle bucket. Once a bucket has not been touched for
 * two full drain periods its level is guaranteed to be 0, so the key can be
 * safely reclaimed — tenants that go quiet do not leak Redis memory.
 */
export function bucketTtlSeconds(ratePerSecond: number, capacity: number): number {
  return Math.max(1, Math.ceil((capacity / ratePerSecond) * 2) + 1);
}

// ─── Lua script (atomic read-modify-write on Redis) ─────────────────────────

/**
 * Atomic leaky-bucket update.
 *
 * KEYS[1] = bucket key (hash { level, ts })
 * ARGV[1] = now_ms
 * ARGV[2] = rate (tokens/second)
 * ARGV[3] = capacity
 * ARGV[4] = amount
 * ARGV[5] = ttl_seconds
 *
 * Returns { allowed(0|1), retry_after_ms, level_x1000 }.
 * `level_x1000` is floor(level*1000) so fractional state crosses the
 * Redis→JS boundary without float serialization drift (divide by 1000 in JS).
 *
 * NOTE: Redis forbids TIME inside scripts, so `now_ms` is passed by the
 * caller. App instances share NTP; residual skew is clamped by the
 * `math.max(0, ...)` guard and self-heals on the next write.
 */
export const LEAKY_BUCKET_LUA = `
local level = tonumber(redis.call('HGET', KEYS[1], 'level') or '0')
local ts = tonumber(redis.call('HGET', KEYS[1], 'ts') or ARGV[1])
local now_ms = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local amount = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local elapsed = math.max(now_ms - ts, 0)
level = math.max(level - (elapsed * rate / 1000), 0)

local allowed = 0
local retry_after_ms = 0
if level + amount <= capacity then
  level = level + amount
  allowed = 1
else
  retry_after_ms = math.ceil(((level + amount - capacity) / rate) * 1000)
end

redis.call('HSET', KEYS[1], 'level', level, 'ts', now_ms)
redis.call('EXPIRE', KEYS[1], ttl)

return { allowed, retry_after_ms, math.floor(level * 1000) }
`.trim();

const LEAKY_BUCKET_LUA_SHA = createHash("sha1").update(LEAKY_BUCKET_LUA, "utf8").digest("hex");

// ─── Store interface ─────────────────────────────────────────────────────────

export interface LeakyBucketStoreConsume {
  ratePerSecond: number;
  capacity: number;
  amount?: number;
}

export interface LeakyBucketStore {
  consume(key: string, params: LeakyBucketStoreConsume): Promise<LeakyBucketDecision>;
}

/** Raised when the Redis round-trip exceeds the configured timeout. */
export class LeakyBucketRedisTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`leaky-bucket Redis eval exceeded ${timeoutMs}ms`);
    this.name = "LeakyBucketRedisTimeoutError";
  }
}

// ─── Redis store ─────────────────────────────────────────────────────────────

/**
 * The minimal ioredis surface used by the limiter. Declared as an interface
 * so unit tests can inject fakes (latency spikes, NOSCRIPT, failures)
 * without a live Redis.
 */
export interface RedisEvalLike {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  evalsha(sha: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  script(
    subcommand: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect?(): void;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  status?: string;
}

function isNoScriptError(err: unknown): boolean {
  return err instanceof Error && err.message.toUpperCase().includes("NOSCRIPT");
}

/**
 * Production store: executes {@link LEAKY_BUCKET_LUA} on Redis.
 *
 * Strategy: EVALSHA with the locally computed SHA-1. On NOSCRIPT (first use
 * after boot / FLUSHALL) fall back to a full EVAL, which also re-caches the
 * script server-side, so only one request per process lifetime pays the
 * double round-trip.
 *
 * Every call is wrapped in a hard timeout (`timeoutMs`); a too-slow Redis
 * surfaces as {@link LeakyBucketRedisTimeoutError} so the middleware can
 * fail open instead of hanging the request (the "latency spike" case).
 */
export class RedisLeakyBucketStore implements LeakyBucketStore {
  constructor(
    private readonly client: RedisEvalLike,
    private readonly timeoutMs: number = configService.bookingsSearchRedisTimeoutMs,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive finite number");
    }
  }

  async consume(key: string, params: LeakyBucketStoreConsume): Promise<LeakyBucketDecision> {
    const nowMs = Date.now();
    const amount = params.amount ?? 1;
    const ttl = bucketTtlSeconds(params.ratePerSecond, params.capacity);
    const args: Array<string | number> = [
      key,
      nowMs,
      params.ratePerSecond,
      params.capacity,
      amount,
      ttl,
    ];

    let raw: unknown;
    try {
      raw = await this.withTimeout(this.client.evalsha(LEAKY_BUCKET_LUA_SHA, 1, ...args));
    } catch (err) {
      if (!isNoScriptError(err)) throw err;
      // Script not cached yet — EVAL re-registers it server-side.
      raw = await this.withTimeout(this.client.eval(LEAKY_BUCKET_LUA, 1, ...args));
    }

    return parseLuaDecision(raw);
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new LeakyBucketRedisTimeoutError(this.timeoutMs)), this.timeoutMs);
      // Don't keep the event loop alive on behalf of an abandoned caller.
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseLuaDecision(raw: unknown): LeakyBucketDecision {
  const tuple = raw as [number | string, number | string, number | string];
  const allowed = Number(tuple[0]) === 1;
  const retryAfterMs = Number(tuple[1]) || 0;
  // level crosses the wire as floor(level * 1000) to avoid float drift.
  const level = (Number(tuple[2]) || 0) / 1000;
  return { allowed, retryAfterMs, level };
}

// ─── In-memory store (test environments / deterministic fallback) ───────────

/**
 * Single-process store with semantics identical to the Lua script (it calls
 * the same {@link decideLeakyBucket} transition). Used automatically in
 * `NODE_ENV=test` so suites never need Redis, and injectable via
 * `setTenantLeakyBucketStore` for deterministic clocks.
 *
 * In a multi-instance deployment this store must NOT be used (it cannot
 * coordinate across processes) — hence its restriction to tests.
 */
interface BucketEntry {
  level: number;
  ts: number;
  /** Mirrors the Redis EXPIRE set by the Lua script. Key is pruned once idle past it. */
  ttlMs: number;
}

export class InMemoryLeakyBucketStore implements LeakyBucketStore {
  private readonly buckets = new Map<string, BucketEntry>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  async consume(key: string, params: LeakyBucketStoreConsume): Promise<LeakyBucketDecision> {
    const ratePerSecond = params.ratePerSecond;
    const capacity = params.capacity;
    const nowMs = this.clock();
    const entry = this.buckets.get(key);
    const decision = decideLeakyBucket(entry?.level ?? 0, entry?.ts ?? nowMs, {
      ratePerSecond,
      capacity,
      amount: params.amount ?? 1,
      nowMs,
    });
    this.buckets.set(key, {
      level: decision.level,
      ts: nowMs,
      ttlMs: bucketTtlSeconds(ratePerSecond, capacity) * 1000,
    });
    this.pruneExpired(nowMs);
    return decision;
  }

  /**
   * Reclaim keys idle beyond their TTL — the exact mirror of the Redis
   * EXPIRE the Lua script applies — so quiet tenants don't leak memory.
   */
  private pruneExpired(nowMs: number): void {
    for (const [key, entry] of this.buckets) {
      if (nowMs - entry.ts > entry.ttlMs) this.buckets.delete(key);
    }
  }

  /** Test helper — clears all bucket state. */
  reset(): void {
    this.buckets.clear();
  }

  /** Test helper — number of live bucket keys. */
  get size(): number {
    return this.buckets.size;
  }
}

// ─── Store lifecycle (lazy singleton with safe test injection) ───────────────

let cachedStore: LeakyBucketStore | undefined;
let cachedClient: RedisEvalLike | undefined;

const require = createRequire(import.meta.url);

type RedisCtor = new (url: string, options: Record<string, unknown>) => RedisEvalLike;

let redisCtorOverride: RedisCtor | undefined;

/**
 * @internal — test hook only. Lets tests run the production store-creation
 * path (options, error handler, lifecycle) against a fake Redis constructor
 * without touching ioredis' network stack.
 */
export function _setRedisCtorForTesting(ctor: RedisCtor | undefined): void {
  redisCtorOverride = ctor;
}

function createRedisStore(): LeakyBucketStore {
  // Lazy require keeps ioredis (and its network client) out of test runs.
  const Ctor: RedisCtor =
    redisCtorOverride ??
    (require("ioredis") as { Redis: RedisCtor }).Redis;
  cachedClient = new Ctor(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    showFriendlyErrorStack: process.env.NODE_ENV !== "production",
    retryStrategy: (times: number) => (times > 10 ? null : Math.min(times * 100, 2000)),
  });
  cachedClient.on("error", (err: unknown) => {
    logger.error({ err }, "tenantLeakyBucket redis error");
  });
  return new RedisLeakyBucketStore(cachedClient);
}

/**
 * Store resolution:
 *   1. Test/injected store (via `setTenantLeakyBucketStore`), else
 *   2. `NODE_ENV=test` → InMemoryLeakyBucketStore (no Redis dependency), else
 *   3. Production → RedisLeakyBucketStore over the shared REDIS_URL client.
 */
export function getTenantLeakyBucketStore(): LeakyBucketStore {
  if (!cachedStore) {
    cachedStore = process.env.NODE_ENV === "test" ? new InMemoryLeakyBucketStore() : createRedisStore();
  }
  return cachedStore;
}

/** Inject a store (tests). Resets the production singleton. */
export function setTenantLeakyBucketStore(store: LeakyBucketStore): void {
  cachedStore = store;
}

/** Restore default store resolution; closes any Redis client it created. */
export async function resetTenantLeakyBucketStore(): Promise<void> {
  cachedStore = undefined;
  if (cachedClient) {
     
    cachedClient.disconnect?.();
    cachedClient = undefined;
  }
}

// ─── Tenant identity resolution ──────────────────────────────────────────────

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export interface TenantIdentity {
  /** namespaced Redis key, e.g. `rlb:bookings:search:user:alice` */
  key: string;
  /** sanitized identifier used as the `tenant` metric label */
  label: string;
}

function hashId(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 32);
}

/**
 * Canonicalize a caller-controlled identifier before embedding it in a
 * Redis key or a metric label. Safe identifiers pass through unchanged;
 * anything else (overlong, exotic charset, attempted key injection like
 * `tenant:vip`) is replaced by a deterministic hash so it can never collide
 * with another logical namespace.
 */
export function sanitizeTenantIdentifier(id: string): string {
  const trimmed = id.trim();
  if (SAFE_ID.test(trimmed)) return trimmed;
  return `h:${hashId(trimmed)}`;
}

function getClientIp(req: Request): string {
   
  const anyReq = req as any;
  return anyReq.ip || anyReq.socket?.remoteAddress || "anonymous";
}

/**
 * Resolve the *trusted* tenant identity for rate limiting.
 *
 * Priority (first match wins):
 *   1. Tenant claim from trusted auth context (`req.auth.tenantId` or
 *      `req.user.tenantId`) — true multi-tenant deployments.
 *   2. Authenticated user (`req.auth.userId` / `req.user.sub||id`) — the
 *      user is the tenant boundary.
 *   3. API key (`req.apiKeyId`) — partner keys map 1:1 to tenants; hashed.
 *   4. Hashed client IP — anonymous traffic cannot crowd out tenants.
 *
 * SECURITY: the `x-tenant-id` request header is deliberately NOT consulted.
 * Trusting it would let any caller pick a fresh, empty bucket per request
 * (limit evasion) and would create unbounded Redis keys / label cardinality.
 */
export function resolveTenantIdentity(req: Request, routeScope = "bookings:search"): TenantIdentity {
   
  const auth = (req as any).auth as Record<string, unknown> | undefined;
  const user = req.user as Record<string, unknown> | undefined;

  const authTenant = firstString(auth?.tenantId, user?.tenantId);
  if (authTenant) {
    const id = sanitizeTenantIdentifier(authTenant);
    return { key: `rlb:${routeScope}:tenant:${id}`, label: id };
  }

  const authUser = firstString(auth?.userId, user?.sub, user?.id);
  if (authUser) {
    const id = sanitizeTenantIdentifier(authUser);
    return { key: `rlb:${routeScope}:user:${id}`, label: id };
  }

   
  const apiKeyId = (req as any).apiKeyId as string | undefined;
  if (typeof apiKeyId === "string" && apiKeyId.trim()) {
    const id = hashId(apiKeyId.trim());
    return { key: `rlb:${routeScope}:apiKey:${id}`, label: `apiKey:${id.slice(0, 16)}` };
  }

  const id = hashId(getClientIp(req));
  return { key: `rlb:${routeScope}:ip:${id}`, label: `ip:${id.slice(0, 16)}` };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

// ─── Express middleware ──────────────────────────────────────────────────────

export interface TenantLeakyBucketOptions {
  /** Sustained requests per second per tenant. Default: config / 60. */
  ratePerSecond?: number;
  /** Burst capacity per tenant. Default: config / 120. */
  capacity?: number;
  /** Work units per request (e.g. weigh expensive queries). Default: 1. */
  amount?: number;
  /** Route scope embedded in Redis keys (namespaces the bucket). */
  routeScope?: string;
  /** Store override (defaults to the lazily-resolved singleton). */
  store?: LeakyBucketStore;
}

/**
 * Per-tenant leaky-bucket rate-limit middleware.
 *
 * On admit: forwards the request and sets `X-RateLimit-Limit`,
 * `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
 * On reject: `429` + `Retry-After` (whole seconds, derived from real bucket
 * state) + error body `{ success: false, error, retryAfter }`.
 * On Redis failure/timeout: fails open (admits) and counts
 * `rate_limit_redis_failures_total`.
 *
 * Always emits the `rate_limit_bucket_burn{tenant}` gauge with the current
 * bucket level so operators can watch per-tenant burn in real time.
 */
export function createTenantLeakyBucketRateLimiter(
  options: TenantLeakyBucketOptions = {},
): RequestHandler {
  const ratePerSecond = options.ratePerSecond ?? configService.bookingsSearchRatePerSecond;
  const capacity = options.capacity ?? configService.bookingsSearchBurst;
  const amount = options.amount ?? 1;
  const routeScope = options.routeScope ?? "bookings:search";

  if (!(ratePerSecond > 0) || !(capacity > 0) || !(amount > 0)) {
    throw new Error("tenant leaky-bucket: ratePerSecond, capacity and amount must be positive");
  }

  const handler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identity = resolveTenantIdentity(req, routeScope);
    const store = options.store ?? getTenantLeakyBucketStore();

    let decision: LeakyBucketDecision;
    try {
      decision = await store.consume(identity.key, { ratePerSecond, capacity, amount });
    } catch (err) {
      // Fail-open: availability first; never take the endpoint down with Redis.
      rateLimitRedisFailuresTotal.inc();
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), tenant: identity.label },
        "tenant leaky-bucket store failure — failing open",
      );
      next();
      return;
    }

    rateLimitBucketBurn.labels(identity.label).set(decision.level);

    const remaining = Math.max(0, Math.floor(capacity - decision.level));
    const resetEpochSec = Math.ceil((Date.now() + (decision.level / ratePerSecond) * 1000) / 1000);

    res.setHeader("X-RateLimit-Limit", String(capacity));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetEpochSec));

    if (!decision.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        success: false,
        error: "Too many requests, please try again later.",
        retryAfter: retryAfterSec,
      });
      return;
    }

    next();
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch((err: unknown) => {
      // Final safety net — still fail open, never crash the request pipeline.
      rateLimitRedisFailuresTotal.inc();
      logger.error({ err }, "tenant leaky-bucket unexpected error — failing open");
      next();
    });
  };
}
