import {
  getSlotMetricsSnapshot,
  recordCacheStatus,
  recordListLatency,
  recordSlotOperation,
  resetSlotMetrics,
} from "../slotMetrics.js";

describe("slotMetrics", () => {
  beforeEach(() => {
    resetSlotMetrics();
  });

  it("records every supported operation and outcome", () => {
    recordSlotOperation("list", "success");
    recordSlotOperation("create", "success");
    recordSlotOperation("update", "success");
    recordSlotOperation("delete", "success");
    recordSlotOperation("list", "error");
    recordSlotOperation("create", "error");
    recordSlotOperation("update", "error");
    recordSlotOperation("delete", "error");

    expect(getSlotMetricsSnapshot().operationCounts).toEqual({
      list_success: 1,
      create_success: 1,
      update_success: 1,
      delete_success: 1,
      list_error: 1,
      create_error: 1,
      update_error: 1,
      delete_error: 1,
    });
  });

  it("records each cache status", () => {
    recordCacheStatus("hit");
    recordCacheStatus("miss");
    recordCacheStatus("bypass");

    expect(getSlotMetricsSnapshot().cacheCounts).toEqual({
      hit: 1,
      miss: 1,
      bypass: 1,
    });
  });

  it("records latency in every bucket at and above the observed duration", () => {
    recordListLatency(10);

    const snapshot = getSlotMetricsSnapshot();
    expect(snapshot.listLatencyCount).toBe(1);
    expect(snapshot.listLatencySum).toBe(10);
    expect(snapshot.listLatencyBuckets).toEqual({
      5: 0,
      10: 1,
      25: 1,
      50: 1,
      100: 1,
      250: 1,
      500: 1,
      1000: 1,
      2500: 1,
      5000: 1,
    });
  });

  it("accepts zero latency and rejects negative or non-finite latency", () => {
    recordListLatency(0);
    recordListLatency(-1);
    recordListLatency(Number.NaN);
    recordListLatency(Number.POSITIVE_INFINITY);

    const snapshot = getSlotMetricsSnapshot();
    expect(snapshot.listLatencyCount).toBe(1);
    expect(snapshot.listLatencySum).toBe(0);
    expect(snapshot.listLatencyBuckets[5]).toBe(1);
  });

  it("bounds unexpected operation and cache labels", () => {
    for (const operation of ["list", "create", "update", "delete"] as const) {
      recordSlotOperation(operation, "success");
      recordSlotOperation(operation, "error");
    }
    recordSlotOperation("unexpected" as never, "success");

    recordCacheStatus("hit");
    recordCacheStatus("miss");
    recordCacheStatus("bypass");
    recordCacheStatus("unexpected" as never);

    const snapshot = getSlotMetricsSnapshot();
    expect(snapshot.operationCounts.__overflow__).toBe(1);
    expect(snapshot.cacheCounts.__overflow__).toBe(1);
    expect(snapshot.cardinalityOverflowCounts).toEqual({
      slot_operation_count: 1,
      slot_cache_status: 1,
    });
  });

  it("returns an isolated snapshot and resets all state", () => {
    recordSlotOperation("list", "success");
    recordCacheStatus("hit");
    recordListLatency(25);

    const snapshot = getSlotMetricsSnapshot();
    snapshot.operationCounts.list_success = 99;
    snapshot.cacheCounts.hit = 99;
    snapshot.listLatencyBuckets[25] = 99;

    expect(getSlotMetricsSnapshot()).toMatchObject({
      operationCounts: { list_success: 1 },
      cacheCounts: { hit: 1 },
      listLatencyBuckets: { 25: 1 },
      listLatencyCount: 1,
      listLatencySum: 25,
    });

    resetSlotMetrics();
    expect(getSlotMetricsSnapshot()).toEqual({
      operationCounts: {},
      listLatencyBuckets: {
        5: 0,
        10: 0,
        25: 0,
        50: 0,
        100: 0,
        250: 0,
        500: 0,
        1000: 0,
        2500: 0,
        5000: 0,
      },
      listLatencyCount: 0,
      listLatencySum: 0,
      cacheCounts: { hit: 0, miss: 0, bypass: 0 },
      cardinalityOverflowCounts: {
        slot_operation_count: 0,
        slot_cache_status: 0,
      },
    });
  });
});