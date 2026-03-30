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
 * Extend the key schema here (e.g. "slots:professional:<id>") as new query
 * dimensions are added.
 */

import {
  getRedisClient,
  SLOT_CACHE_TTL_SECONDS,
} from "./redisClient.js";


export const SLOT_CACHE_KEYS = {
  all: "slots:all",
} as const;


export interface Slot {
  id: number;
  professional: string;
  startTime: string;
  endTime: string;
}


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