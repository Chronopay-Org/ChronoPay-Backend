/**
 * Escrow Listener Idempotency Store
 * --------------------------------
 *
 * Records that a specific escrow event has been observed and projected to
 * local state. The natural key is `(txHash, eventIndex)` — together they
 * uniquely identify an event emitted inside a single transaction.
 *
 * Why two layers?
 *
 * - The cursor advances AFTER every event in a batch is processed. If the
 *   listener crashes mid-batch, on restart the same batch will be re-fetched.
 *   The cursor alone would require reprocessing.
 * - The idempotency store gates each event with `SET ... NX`, so a re-fetched
 *   batch becomes a stream of no-ops and the cursor still advances. Reprocess
 *   is therefore cheap and safe.
 *
 * The TTL is intentionally long (7 days) to ride out any realistic
 * crash-recovery window. Older keys are allowed to drop; their events no
 * longer exist on-chain (finality + chain rollbacks within 7 days are
 * exceedingly rare for a financial system).
 */

export interface IdempotencyStore {
  /**
   * Atomically claim processing rights for `eventKey`. Returns:
   *   true  - first time this event has been seen; caller should project.
   *   false - event has already been claimed; caller should skip.
   */
  claim(eventKey: string): Promise<boolean>;

  /**
   * Release a previously-grabbed claim. Used when processing fails and we
   * want a future tick to retry. Idempotent: releasing a non-existent key
   * is a no-op.
   */
  release(eventKey: string): Promise<void>;
}

export function idempotencyKey(eventKey: string): string {
  return `escrow:listener:idempotency:${eventKey}`;
}

const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

export class RedisIdempotencyStore implements IdempotencyStore {
  async claim(eventKey: string): Promise<boolean> {
    // Lazy import via singleton to avoid pulling ioredis into test paths.
    const { getRedisClient } = await import("../utils/redis.js");
    const result = await getRedisClient().set(
      idempotencyKey(eventKey),
      "1",
      "EX",
      IDEMPOTENCY_TTL_SECONDS,
      "NX",
    );
    return result === "OK";
  }

  async release(eventKey: string): Promise<void> {
    const { getRedisClient } = await import("../utils/redis.js");
    await getRedisClient().del(idempotencyKey(eventKey));
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly claims = new Map<string, number>();
  private readonly failNextClaim = new Set<string>();
  private readonly releaseAfterFail = new Set<string>();

  async claim(eventKey: string): Promise<boolean> {
    if (this.failNextClaim.has(eventKey)) {
      this.failNextClaim.delete(eventKey);
      // Simulate a transient SET NX miss (e.g. another worker beat us).
      // Caller will see false and skip processing.
      return false;
    }
    if (this.claims.has(eventKey)) {
      // Already claimed.
      return false;
    }
    this.claims.set(eventKey, Date.now());
    return true;
  }

  async release(eventKey: string): Promise<void> {
    if (this.releaseAfterFail.has(eventKey)) {
      this.releaseAfterFail.delete(eventKey);
      this.claims.delete(eventKey);
      return;
    }
    this.claims.delete(eventKey);
  }

  // Test helpers
  seedClaimed(eventKey: string): void {
    this.claims.set(eventKey, Date.now());
  }
  failNextClaimOnce(eventKey: string): void {
    this.failNextClaim.add(eventKey);
  }
  size(): number {
    return this.claims.size;
  }
  has(eventKey: string): boolean {
    return this.claims.has(eventKey);
  }
}
