import { getRedisClient } from "../utils/redis.js";

/** TTL for a dedup key: 25 hours covers any reasonable retry window. */
const DEDUP_TTL_SECONDS = 25 * 60 * 60;

/**
 * Builds a dedup key from reminder id and triggerAt timestamp.
 * Contains no PII — only opaque numeric identifiers.
 */
export function dedupKey(reminderId: number, triggerAt: number): string {
  return `reminder:dedup:${reminderId}:${triggerAt}`;
}

/**
 * Atomically claims a dedup slot.
 * Returns true  → this worker owns the delivery (proceed).
 * Returns false → another worker already claimed it (skip).
 */
export async function claimDelivery(reminderId: number, triggerAt: number): Promise<boolean> {
  const redis = getRedisClient();
  const key = dedupKey(reminderId, triggerAt);
  // SET key "1" EX <ttl> NX — returns "OK" on success, null if key exists
  const result = await redis.set(key, "1", "EX", DEDUP_TTL_SECONDS, "NX");
  return result === "OK";
}
