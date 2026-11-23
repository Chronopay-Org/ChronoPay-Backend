/**
 * Escrow Listener Cursor Store
 * ----------------------------
 *
 * Stores the last applied ledger sequence per listener instance. The cursor
 * is a single monotonic integer that the listener advances AFTER every event
 * in a batch has been durably projected to local state.
 *
 * Crash recovery: if the listener crashes before advancing the cursor,
 * the same events will be re-fetched and re-projected on restart. The
 * `escrowIdempotencyStore` deduplicates re-applied events so this is safe.
 *
 * The cursor is stored with a long TTL (default 30 days) so the listener
 * cleanly observes liveness gaps (e.g. a paused process) and does not have
 * to re-walk the history from genesis.
 */

import { getRedisClient } from "../utils/redis.js";

export interface CursorStore {
  /** Returns the last applied ledger sequence, or null if none exists yet. */
  get(instanceId: string): Promise<number | null>;

  /**
   * Atomically set the cursor for an instance. The implementation MUST
   * reject calls that would decrease the cursor (cursor is monotonic).
   */
  set(instanceId: string, value: number): Promise<void>;
}

export function cursorKey(instanceId: string): string {
  return `escrow:listener:cursor:${instanceId}`;
}

export class RedisCursorStore implements CursorStore {
  private readonly ttlSeconds: number;

  constructor(ttlSeconds: number = 30 * 24 * 60 * 60) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`RedisCursorStore ttlSeconds must be a positive integer`);
    }
    this.ttlSeconds = ttlSeconds;
  }

  async get(instanceId: string): Promise<number | null> {
    const raw = await getRedisClient().get(cursorKey(instanceId));
    if (raw == null) return null;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        `Corrupt cursor value for instance '${instanceId}': ${String(raw)}`,
      );
    }
    return parsed;
  }

  async set(instanceId: string, value: number): Promise<void> {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `Cursor value must be a non-negative integer, received: ${value}`,
      );
    }
    const current = await this.get(instanceId);
    if (current !== null && value < current) {
      throw new Error(
        `Cursor cannot regress for instance '${instanceId}': current=${current} attempted=${value}`,
      );
    }
    await getRedisClient().set(
      cursorKey(instanceId),
      String(value),
      "EX",
      this.ttlSeconds,
    );
  }
}

export class InMemoryCursorStore implements CursorStore {
  private readonly values = new Map<string, number>();
  private readonly failNext = new Set<string>();

  async get(instanceId: string): Promise<number | null> {
    return this.values.get(instanceId) ?? null;
  }

  async set(instanceId: string, value: number): Promise<void> {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `Cursor value must be a non-negative integer, received: ${value}`,
      );
    }
    if (this.failNext.has(instanceId)) {
      this.failNext.delete(instanceId);
      throw new Error(`Simulated cursor write failure for instance '${instanceId}'`);
    }
    const current = this.values.get(instanceId);
    if (current !== undefined && value < current) {
      throw new Error(
        `Cursor cannot regress for instance '${instanceId}': current=${current} attempted=${value}`,
      );
    }
    this.values.set(instanceId, value);
  }

  // Test helpers
  seed(instanceId: string, value: number): void {
    this.values.set(instanceId, value);
  }
  failNextSet(instanceId: string): void {
    this.failNext.add(instanceId);
  }
  size(): number {
    return this.values.size;
  }
}
