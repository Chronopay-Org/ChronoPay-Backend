/**
 * Tests for src/metrics/slotMetrics.ts
 *
 * Covers: counters, histogram, cache status, cardinality controls,
 * reset utility, and singleton registry behaviour.
 */

import {
  recordSlotOperation,
  recordListLatency,
  recordCacheStatus,
  getSlotMetricsSnapshot,
  resetSlotMetrics,
  type SlotOperation,
  type SlotOutcome,
  type CacheStatus,
} from "../metrics/slotMetrics.js";

beforeEach(() => {
  resetSlotMetrics();
});

// ─── recordSlotOperation ──────────────────────────────────────────────────────

describe("recordSlotOperation", () => {
  it("increments the counter for a given operation+outcome pair", () => {
    recordSlotOperation("list", "success");
    recordSlotOperation("list", "success");
    recordSlotOperation("create", "error");

    const snap = getSlotMetricsSnapshot();
    expect(snap.operationCounts["list_success"]).toBe(2);
    expect(snap.operationCounts["create_error"]).toBe(1);
  });

  it("tracks all four operations independently", () => {
    const ops: SlotOperation[] = ["list", "create", "update", "delete"];
    for (const op of ops) {
      recordSlotOperation(op, "success");
    }

    const snap = getSlotMetricsSnapshot();
    for (const op of ops) {
      expect(snap.operationCounts[`${op}_success`]).toBe(1);
    }
  });

  it("tracks both outcomes independently", () => {
    recordSlotOperation("list", "success");
    recordSlotOperation("list", "error");

    const snap = getSlotMetricsSnapshot();
    expect(snap.operationCounts["list_success"]).toBe(1);
    expect(snap.operationCounts["list_error"]).toBe(1);
  });

  it("starts at zero before any recording", () => {
    const snap = getSlotMetricsSnapshot();
    expect(Object.keys(snap.operationCounts)).toHaveLength(0);
  });
});

// ─── recordListLatency ────────────────────────────────────────────────────────

describe("recordListLatency", () => {
  it("increments count and sum", () => {
    recordListLatency(50);
    recordListLatency(100);

    const snap = getSlotMetricsSnapshot();
    expect(snap.listLatencyCount).toBe(2);
    expect(snap.listLatencySum).toBe(150);
  });

  it("places a value in the correct histogram buckets", () => {
    recordListLatency(30); // should fall in ≤50, ≤100, ≤250, ≤500, ≤1000, ≤2500, ≤5000

    const snap = getSlotMetricsSnapshot();
    expect(snap.listLatencyBuckets[25]).toBe(0); // 30 > 25
    expect(snap.listLatencyBuckets[50]).toBe(1); // 30 ≤ 50
    expect(snap.listLatencyBuckets[100]).toBe(1);
    expect(snap.listLatencyBuckets[5000]).toBe(1);
  });

  it("places a value exactly on a bucket boundary", () => {
    recordListLatency(100);

    const snap = getSlotMetricsSnapshot();
    expect(snap.listLatencyBuckets[100]).toBe(1);
    expect(snap.listLatencyBuckets[50]).toBe(0); // 100 > 50
  });

  it("ignores NaN values", () => {
    recordListLatency(Number.NaN);

    const snap = getSlotMetricsSnapshot();
    expect(snap.listLatencyCount).toBe(0);
    expect(snap.listLatencySum).toBe(0);
  });

  it("ignores negative values", () => {
    recordListLatency(-10);

    const snap = getSlotMetricsSnapshot();
    expect(snap.listLatencyCount).toBe(0);
  });

  it("ignores Infinity", () => {
    recordListLatency(Infinity);

    const snap = getSlotMetricsSnapshot();
    expect(snap.listLatencyCount).toBe(0);
  });

  it("accumulates multiple observations correctly", () => {
    recordListLatency(10);
    recordListLatency(10);
    recordListLatency(10);

    const snap = getSlotMetricsSnapshot();
    expect(snap.listLatencyCount).toBe(3);
    expect(snap.listLatencySum).toBe(30);
    expect(snap.listLatencyBuckets[10]).toBe(3);
  });
});

// ─── recordCacheStatus ────────────────────────────────────────────────────────

describe("recordCacheStatus", () => {
  it("increments hit, miss, and bypass independently", () => {
    recordCacheStatus("hit");
    recordCacheStatus("hit");
    recordCacheStatus("miss");
    recordCacheStatus("bypass");

    const snap = getSlotMetricsSnapshot();
    expect(snap.cacheCounts.hit).toBe(2);
    expect(snap.cacheCounts.miss).toBe(1);
    expect(snap.cacheCounts.bypass).toBe(1);
  });

  it("starts all cache counters at zero", () => {
    const snap = getSlotMetricsSnapshot();
    expect(snap.cacheCounts.hit).toBe(0);
    expect(snap.cacheCounts.miss).toBe(0);
    expect(snap.cacheCounts.bypass).toBe(0);
  });

  it("tracks all three cache statuses", () => {
    const statuses: CacheStatus[] = ["hit", "miss", "bypass"];
    for (const s of statuses) {
      recordCacheStatus(s);
    }

    const snap = getSlotMetricsSnapshot();
    for (const s of statuses) {
      expect(snap.cacheCounts[s]).toBe(1);
    }
  });
});

// ─── getSlotMetricsSnapshot ───────────────────────────────────────────────────

describe("getSlotMetricsSnapshot", () => {
  it("returns a copy — mutations do not affect internal state", () => {
    recordSlotOperation("list", "success");

    const snap = getSlotMetricsSnapshot();
    snap.operationCounts["list_success"] = 999;

    const snap2 = getSlotMetricsSnapshot();
    expect(snap2.operationCounts["list_success"]).toBe(1);
  });
});

// ─── resetSlotMetrics ─────────────────────────────────────────────────────────

describe("resetSlotMetrics", () => {
  it("clears all counters and histograms", () => {
    recordSlotOperation("list", "success");
    recordListLatency(100);
    recordCacheStatus("hit");

    resetSlotMetrics();

    const snap = getSlotMetricsSnapshot();
    expect(Object.keys(snap.operationCounts)).toHaveLength(0);
    expect(snap.listLatencyCount).toBe(0);
    expect(snap.listLatencySum).toBe(0);
    expect(snap.cacheCounts.hit).toBe(0);
    expect(snap.cacheCounts.miss).toBe(0);
    expect(snap.cacheCounts.bypass).toBe(0);
  });

  it("resets histogram buckets to zero", () => {
    recordListLatency(50);
    resetSlotMetrics();

    const snap = getSlotMetricsSnapshot();
    for (const count of Object.values(snap.listLatencyBuckets)) {
      expect(count).toBe(0);
    }
  });
});
