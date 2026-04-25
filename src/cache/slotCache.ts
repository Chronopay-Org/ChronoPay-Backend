/**
 *
 * High-level cache helpers for the slot resource.
 *
 * All functions are safe to call even when Redis is unavailable: errors are
 * caught, logged, and a sensible default is returned so callers never need to
 * handle Redis failures themselves.
 *
 * Cache key schema
 * ────────────────
 *   slots:all          → serialised array of all slots
 *
 * Stampede protection
 * ───────────────────
 * `getOrFetchSlots` implements a single-flight pattern: when the cache is cold
 * and multiple concurrent requests arrive simultaneously, only the first
 * request triggers the origin fetch.  All subsequent in-flight requests wait
 * on the same Promise and receive the same result, preventing a thundering-herd
 * of redundant origin calls.
 *
 * Extend the key schema here (e.g. "slots:professional:<id>") as new query
 * dimensions are added.
 */

import {
  getRedisClient,
  SLOT_CACHE_TTL_SECONDS,
} from "./redisClient.js";
import { recordCacheHit, recordCacheMiss, recordStampedeBlocked } from "../metrics.js";


export const SLOT_CACHE_KEYS = {
  all: "slots:all",
} as const;


export interface Slot {
  id: number;
  professional: string;
  startTime: string;
  endTime: string;
}

// ─── Single-flight registry ───────────────────────────────────────────────────
// Maps cache key → in-flight Promise so concurrent cold-cache requests coalesce.
const _inFlight = new Map<string, Promise<Slot[]>>();

/**
 * Retrieve the cached slot list.
 *
 * @returns Parsed slot array on cache HIT, or `null` on MISS / error.
 */
export async function getCachedSlots(): Promise<Slot[] | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  try {
    const raw = await redis.get(SLOT_CACHE_KEYS.all);
    if (raw === null) return null;
    return JSON.parse(raw) as Slot[];
  } catch (err) {
    console.warn("[slotCache] getCachedSlots error:", (err as Error).message);
    return null;
  }
}

/**
 * Write the slot list to the cache with the configured TTL.
 *
 * @param slots  - Array of slot objects to serialise and store.
 */
export async function setCachedSlots(slots: Slot[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    await redis.set(
      SLOT_CACHE_KEYS.all,
      JSON.stringify(slots),
      "EX",
      SLOT_CACHE_TTL_SECONDS,
    );
  } catch (err) {
    console.warn("[slotCache] setCachedSlots error:", (err as Error).message);
  }
}

/**
 * Invalidate the slot list cache entry.
 *
 * Called after any write operation (POST, PUT, DELETE) so that the next GET
 * reflects the updated state.
 */
export async function invalidateSlotsCache(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    await redis.del(SLOT_CACHE_KEYS.all);
  } catch (err) {
    console.warn("[slotCache] invalidateSlotsCache error:", (err as Error).message);
  }
}

/**
 * Single-flight cache-or-fetch for the slot list.
 *
 * - Cache HIT  → returns cached data immediately; increments hit counter.
 * - Cache MISS, no in-flight request → calls `fetcher`, writes result to cache,
 *   increments miss counter.
 * - Cache MISS, in-flight request already running → joins the existing Promise
 *   instead of issuing a second origin call; increments stampede-blocked counter.
 *
 * @param fetcher  - Async function that loads slots from the origin (DB / store).
 * @returns `{ slots, cacheStatus }` where cacheStatus is "HIT", "MISS", or "STAMPEDE_BLOCKED".
 */
export async function getOrFetchSlots(
  fetcher: () => Promise<Slot[]>,
): Promise<{ slots: Slot[]; cacheStatus: "HIT" | "MISS" | "STAMPEDE_BLOCKED" }> {
  const key = SLOT_CACHE_KEYS.all;

  // ── 1. Try cache ────────────────────────────────────────────────────────────
  const cached = await getCachedSlots();
  if (cached !== null) {
    recordCacheHit();
    return { slots: cached, cacheStatus: "HIT" };
  }

  // ── 2. Check for an in-flight request (stampede protection) ─────────────────
  const existing = _inFlight.get(key);
  if (existing) {
    recordStampedeBlocked();
    const slots = await existing;
    return { slots, cacheStatus: "STAMPEDE_BLOCKED" };
  }

  // ── 3. We are the first — run the fetch and share the Promise ────────────────
  recordCacheMiss();
  const fetchPromise = fetcher().then(async (slots) => {
    await setCachedSlots(slots);
    return slots;
  }).finally(() => {
    _inFlight.delete(key);
  });

  _inFlight.set(key, fetchPromise);

  const slots = await fetchPromise;
  return { slots, cacheStatus: "MISS" };
}

/**
 * Exposed for testing: returns the current in-flight map size.
 * @internal
 */
export function _getInFlightCount(): number {
  return _inFlight.size;
}

/**
 * Exposed for testing: clears the in-flight map (use in beforeEach/afterEach).
 * @internal
 */
export function _clearInFlight(): void {
  _inFlight.clear();
}