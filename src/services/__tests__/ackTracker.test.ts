/**
 * Tests for AckTracker
 *
 * Covers:
 * - recordAck writes to correct Redis hash key with TTL
 * - recordAck validates keyId and replicaId
 * - getAcks returns all ack entries
 * - getAcks returns empty array when key missing
 * - getAckRate happy path
 * - getAckRate when no acks (returns 0)
 * - getAckRate with knownReplicaCount=0 (vacuously 1.0)
 * - Multiple replicas acking the same keyId
 * - Custom prefix and TTL options
 */

import { describe, it, expect } from "@jest/globals";
import { AckTracker, type AckRedisClient } from "../ackTracker.js";
import type { RevocationAck } from "../revocationService.js";

// ─── Fake Redis ───────────────────────────────────────────────────────────────

class FakeAckRedis implements AckRedisClient {
  private hashes = new Map<string, Map<string, string>>();
  ttlCalls: Array<{ key: string; seconds: number }> = [];

  async hset(key: string, field: string, value: string): Promise<number> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const wasNew = !this.hashes.get(key)!.has(field);
    this.hashes.get(key)!.set(field, value);
    return wasNew ? 1 : 0;
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const map = this.hashes.get(key);
    if (!map || map.size === 0) return null;
    return Object.fromEntries(map.entries());
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.ttlCalls.push({ key, seconds });
    return 1;
  }

  /** Test helper: simulate expired/missing key */
  deleteKey(key: string): void {
    this.hashes.delete(key);
  }
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

function makeTracker(opts?: { prefix?: string; ttl?: number }) {
  const redis = new FakeAckRedis();
  const tracker = new AckTracker({
    redis,
    keyPrefix: opts?.prefix,
    ttlSeconds: opts?.ttl,
  });
  return { redis, tracker };
}

function makeAck(keyId: string, replicaId: string): RevocationAck {
  return { keyId, replicaId, ackedAt: new Date().toISOString() };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AckTracker — recordAck()", () => {
  it("stores ack under the correct hash key", async () => {
    const { redis, tracker } = makeTracker();
    await tracker.recordAck(makeAck("key-1", "replica-A"));

    const raw = await redis.hgetall("revoke:ack:key-1");
    expect(raw).not.toBeNull();
    expect(Object.keys(raw!)).toContain("replica-A");
  });

  it("sets TTL after writing", async () => {
    const { redis, tracker } = makeTracker({ ttl: 70 });
    await tracker.recordAck(makeAck("key-1", "replica-A"));

    expect(redis.ttlCalls).toHaveLength(1);
    expect(redis.ttlCalls[0]).toEqual({ key: "revoke:ack:key-1", seconds: 70 });
  });

  it("uses default TTL of 70 when not specified", async () => {
    const { redis, tracker } = makeTracker();
    await tracker.recordAck(makeAck("key-ttl", "r1"));
    expect(redis.ttlCalls[0].seconds).toBe(70);
  });

  it("uses custom key prefix", async () => {
    const { redis, tracker } = makeTracker({ prefix: "custom:prefix:" });
    await tracker.recordAck(makeAck("key-2", "r1"));

    const raw = await redis.hgetall("custom:prefix:key-2");
    expect(raw).not.toBeNull();
  });

  it("multiple replicas acking the same key are stored under different fields", async () => {
    const { redis, tracker } = makeTracker();
    await tracker.recordAck(makeAck("key-multi", "r1"));
    await tracker.recordAck(makeAck("key-multi", "r2"));
    await tracker.recordAck(makeAck("key-multi", "r3"));

    const raw = await redis.hgetall("revoke:ack:key-multi");
    expect(Object.keys(raw!)).toHaveLength(3);
  });

  it("throws when keyId is empty", async () => {
    const { tracker } = makeTracker();
    await expect(tracker.recordAck(makeAck("", "r1"))).rejects.toThrow("keyId must be non-empty");
  });

  it("throws when keyId is whitespace only", async () => {
    const { tracker } = makeTracker();
    await expect(tracker.recordAck(makeAck("   ", "r1"))).rejects.toThrow("keyId must be non-empty");
  });

  it("throws when replicaId is empty", async () => {
    const { tracker } = makeTracker();
    await expect(tracker.recordAck(makeAck("key-x", ""))).rejects.toThrow("replicaId must be non-empty");
  });
});

describe("AckTracker — getAcks()", () => {
  it("returns all ack entries for a key", async () => {
    const { tracker } = makeTracker();
    const now = new Date().toISOString();
    await tracker.recordAck({ keyId: "key-A", replicaId: "r1", ackedAt: now });
    await tracker.recordAck({ keyId: "key-A", replicaId: "r2", ackedAt: now });

    const acks = await tracker.getAcks("key-A");
    expect(acks).toHaveLength(2);
    expect(acks.map((a) => a.replicaId).sort()).toEqual(["r1", "r2"]);
  });

  it("returns empty array when no acks exist", async () => {
    const { tracker } = makeTracker();
    const acks = await tracker.getAcks("non-existent-key");
    expect(acks).toEqual([]);
  });

  it("returns empty array after key has been deleted (simulated TTL)", async () => {
    const { redis, tracker } = makeTracker();
    await tracker.recordAck(makeAck("key-expired", "r1"));
    redis.deleteKey("revoke:ack:key-expired");

    const acks = await tracker.getAcks("key-expired");
    expect(acks).toEqual([]);
  });
});

describe("AckTracker — getAckRate()", () => {
  it("returns 1.0 when all known replicas have acked", async () => {
    const { tracker } = makeTracker();
    await tracker.recordAck(makeAck("key-R", "r1"));
    await tracker.recordAck(makeAck("key-R", "r2"));

    expect(await tracker.getAckRate("key-R", 2)).toBe(1.0);
  });

  it("returns 0.5 when half of replicas have acked", async () => {
    const { tracker } = makeTracker();
    await tracker.recordAck(makeAck("key-half", "r1"));

    expect(await tracker.getAckRate("key-half", 2)).toBe(0.5);
  });

  it("returns 0 when no acks exist", async () => {
    const { tracker } = makeTracker();
    expect(await tracker.getAckRate("key-none", 5)).toBe(0);
  });

  it("returns 1.0 when knownReplicaCount is 0 (vacuously satisfied)", async () => {
    const { tracker } = makeTracker();
    expect(await tracker.getAckRate("key-zero", 0)).toBe(1.0);
  });

  it("handles partial ack — 3 of 5 replicas", async () => {
    const { tracker } = makeTracker();
    for (const r of ["r1", "r2", "r3"]) {
      await tracker.recordAck(makeAck("key-partial", r));
    }
    expect(await tracker.getAckRate("key-partial", 5)).toBeCloseTo(0.6);
  });

  it("ack rate can exceed 1.0 if more replicas than expected acked (not clamped)", async () => {
    // This is intentional — AlarmService should not alarm in this case
    const { tracker } = makeTracker();
    await tracker.recordAck(makeAck("key-extra", "r1"));
    await tracker.recordAck(makeAck("key-extra", "r2"));
    await tracker.recordAck(makeAck("key-extra", "r3"));

    // 3 acks but only 2 expected
    expect(await tracker.getAckRate("key-extra", 2)).toBeCloseTo(1.5);
  });
});
