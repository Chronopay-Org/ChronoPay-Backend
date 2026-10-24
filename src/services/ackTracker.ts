/**
 * AckTracker
 *
 * Persists per-replica acknowledgements for each revocation event in Redis
 * so that operators can review which replicas acknowledged within the SLA
 * window after an incident.
 *
 * Storage layout
 * ──────────────
 * Key  : `revoke:ack:<keyId>`   (Redis Hash)
 * Field: `<replicaId>`
 * Value: ISO-8601 timestamp when the ack was received
 *
 * Each key is set with a TTL slightly larger than the alarm window (70 s by
 * default) to guarantee the AlarmService can still read acks at the end of
 * the 60 s window even with small clock skew.  The TTL is refreshed on every
 * write to the hash.
 *
 * Ack rate
 * ────────
 * `getAckRate(keyId, knownReplicaCount)` returns the fraction of known
 * replicas that have acknowledged, which AlarmService uses to decide whether
 * to fire an alarm.
 */

import type { RevocationAck } from "./revocationService.js";

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * Minimal Redis surface required by AckTracker.
 * Tests inject an in-memory fake implementing this interface.
 */
export interface AckRedisClient {
  /** Redis HSET (ioredis variadic form: hset(key, field, value, …)) */
  hset(key: string, field: string, value: string): Promise<number>;
  /** Redis HGETALL */
  hgetall(key: string): Promise<Record<string, string> | null>;
  /** Redis EXPIRE (seconds) */
  expire(key: string, seconds: number): Promise<number>;
}

export interface AckTrackerOptions {
  redis: AckRedisClient;
  /** Key prefix. Defaults to "revoke:ack:". */
  keyPrefix?: string;
  /**
   * TTL in seconds applied to each ack hash after every write.
   * Should be >= alarmWindowMs / 1000 + some safety margin.
   * Defaults to 70 s.
   */
  ttlSeconds?: number;
}

// ─── AckEntry ────────────────────────────────────────────────────────────────

export interface AckEntry {
  replicaId: string;
  ackedAt: string;
}

// ─── AckTracker ──────────────────────────────────────────────────────────────

export class AckTracker {
  private readonly redis: AckRedisClient;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  constructor(opts: AckTrackerOptions) {
    this.redis = opts.redis;
    this.keyPrefix = opts.keyPrefix ?? "revoke:ack:";
    this.ttlSeconds = opts.ttlSeconds ?? 70;
  }

  /**
   * Record that `replicaId` acknowledged revocation of `keyId`.
   *
   * Uses two commands: HSET + EXPIRE. The EXPIRE is re-applied on every write
   * so the TTL slides forward if the same key gets re-revoked.
   */
  async recordAck(ack: RevocationAck): Promise<void> {
    const { keyId, replicaId, ackedAt } = ack;

    if (!keyId || keyId.trim().length === 0) {
      throw new Error("AckTracker.recordAck: keyId must be non-empty");
    }
    if (!replicaId || replicaId.trim().length === 0) {
      throw new Error("AckTracker.recordAck: replicaId must be non-empty");
    }

    const redisKey = this.keyPrefix + keyId.trim();
    await this.redis.hset(redisKey, replicaId.trim(), ackedAt);
    await this.redis.expire(redisKey, this.ttlSeconds);
  }

  /**
   * Return all ack entries for a given revoked key.
   * Returns an empty array if no acks exist (key missing or expired).
   */
  async getAcks(keyId: string): Promise<AckEntry[]> {
    const redisKey = this.keyPrefix + keyId.trim();
    const raw = await this.redis.hgetall(redisKey);
    if (!raw) return [];

    return Object.entries(raw).map(([replicaId, ackedAt]) => ({ replicaId, ackedAt }));
  }

  /**
   * Returns the fraction of `knownReplicaCount` replicas that have acked.
   *
   * - If knownReplicaCount is 0, returns 1.0 (vacuously satisfied).
   * - If no acks exist at all, returns 0.
   */
  async getAckRate(keyId: string, knownReplicaCount: number): Promise<number> {
    if (knownReplicaCount <= 0) return 1.0;

    const acks = await this.getAcks(keyId);
    return acks.length / knownReplicaCount;
  }
}
