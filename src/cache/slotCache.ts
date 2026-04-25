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
 *   slots:all          → serialised array of all slots (legacy, deprecated)
 *   slots:page:<num>   → paginated slot lists (page 1, 2, 3, etc.)
 *
 * Security: Cache keys contain only numeric page numbers and resource names.
 * No PII or sensitive data is included in cache keys.
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
  page: (pageNum: number) => `slots:page:${pageNum}`,
  pattern: "slots:page:*",
} as const;


export interface Slot {
  id: number;
  professional: string;
  startTime: string;
  endTime: string;
}

export interface PaginatedSlotsResult {
  slots: Slot[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}


/**
 * Retrieve cached slots for a specific page.
 *
 * @param page - Page number (1-indexed)
 * @returns Parsed paginated result on cache HIT, or `null` on MISS / error.
 */
export async function getCachedSlotsPage(page: number): Promise<PaginatedSlotsResult | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  try {
    const key = SLOT_CACHE_KEYS.page(page);
    const raw = await redis.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as PaginatedSlotsResult;
  } catch (err) {
    console.warn("[slotCache] getCachedSlotsPage error:", (err as Error).message);
    return null;
  }
}

/**
 * Write paginated slots to cache with the configured TTL.
 *
 * @param page - Page number (1-indexed)
 * @param result - Paginated result to serialise and store.
 */
export async function setCachedSlotsPage(page: number, result: PaginatedSlotsResult): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const key = SLOT_CACHE_KEYS.page(page);
    await redis.set(
      key,
      JSON.stringify(result),
      "EX",
      SLOT_CACHE_TTL_SECONDS,
    );
  } catch (err) {
    console.warn("[slotCache] setCachedSlotsPage error:", (err as Error).message);
  }
}

/**
 * Invalidate all paginated slot cache entries.
 *
 * Called after any write operation (POST, PUT, DELETE) so that the next GET
 * reflects the updated state. Uses KEYS pattern matching to delete all page keys.
 *
 * Security: The pattern "slots:page:*" only matches our own cache keys and
 * does not include user input or PII.
 */
export async function invalidateSlotsCache(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    // Delete all paginated slot cache keys
    const keys = await redis.keys(SLOT_CACHE_KEYS.pattern);
    if (keys.length > 0) {
      await Promise.all(keys.map(key => redis.del(key)));
    }
    
    // Also delete legacy key for backward compatibility
    await redis.del(SLOT_CACHE_KEYS.all);
  } catch (err) {
    console.warn("[slotCache] invalidateSlotsCache error:", (err as Error).message);
  }
}

/**
 * Retrieve the cached slot list (legacy, for backward compatibility).
 *
 * @deprecated Use getCachedSlotsPage instead for paginated access.
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
 * Write the slot list to the cache with the configured TTL (legacy).
 *
 * @deprecated Use setCachedSlotsPage instead for paginated access.
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