import {
  getTzDriftMetricsSnapshot,
  recordAmbiguousSlots,
  recordMissingTzSlots,
  recordScanCompleted,
  recordSlotsScanned,
  resetTzDriftMetrics,
  type TzDriftMetricsSnapshot,
  type TzDriftSeverity,
} from "../tzDriftMetrics.js";

const severities: TzDriftSeverity[] = ["critical", "warning", "info"];

describe("tzDriftMetrics", () => {
  beforeEach(resetTzDriftMetrics);

  it("starts with an empty snapshot", () => {
    const snapshot: TzDriftMetricsSnapshot = getTzDriftMetricsSnapshot();

    expect(snapshot).toEqual({
      ambiguousCounts: {},
      missingTzCounts: {},
      lastScanTimestampMs: 0,
      totalScanned: 0,
      cardinalityOverflowCounts: {
        tz_drift_ambiguous_slots: 0,
        tz_drift_missing_tz_slots: 0,
      },
    });
  });

  it.each(severities)("tracks %s counts separately by tenant and metric", (severity) => {
    recordAmbiguousSlots("tenant-a", severity, 2);
    recordAmbiguousSlots("tenant-a", severity, 3);
    recordAmbiguousSlots("tenant-b", severity, 7);
    recordMissingTzSlots("tenant-a", severity, 11);

    const snapshot = getTzDriftMetricsSnapshot();
    expect(snapshot.ambiguousCounts).toEqual({
      [`tenant-a_${severity}`]: 5,
      [`tenant-b_${severity}`]: 7,
    });
    expect(snapshot.missingTzCounts).toEqual({ [`tenant-a_${severity}`]: 11 });
  });

  it("keeps severity labels separate for the same tenant", () => {
    for (const severity of severities) {
      recordAmbiguousSlots("tenant-a", severity, 1);
    }

    expect(getTzDriftMetricsSnapshot().ambiguousCounts).toEqual({
      "tenant-a_critical": 1,
      "tenant-a_warning": 1,
      "tenant-a_info": 1,
    });
  });

  it.each([Number.NaN, Infinity, -Infinity, -1])(
    "ignores invalid count %s without changing metric state",
    (count) => {
      recordAmbiguousSlots("tenant-a", "critical", 2);
      recordMissingTzSlots("tenant-a", "warning", 3);
      recordSlotsScanned(4);
      const before = getTzDriftMetricsSnapshot();

      recordAmbiguousSlots("invalid", "critical", count);
      recordMissingTzSlots("invalid", "warning", count);
      recordSlotsScanned(count);

      expect(getTzDriftMetricsSnapshot()).toEqual(before);
    },
  );

  it("accepts zero counts and accumulates scanned slots", () => {
    recordAmbiguousSlots("tenant-a", "info", 0);
    recordMissingTzSlots("tenant-a", "info", 0);
    recordSlotsScanned(0);
    recordSlotsScanned(2);
    recordSlotsScanned(3);

    const snapshot = getTzDriftMetricsSnapshot();
    expect(snapshot.ambiguousCounts).toEqual({ "tenant-a_info": 0 });
    expect(snapshot.missingTzCounts).toEqual({ "tenant-a_info": 0 });
    expect(snapshot.totalScanned).toBe(5);
  });

  it("stores the latest valid scan timestamp and ignores invalid timestamps", () => {
    recordScanCompleted(1_700_000_000_000);
    for (const timestamp of [0, -1, Number.NaN, Infinity, -Infinity]) {
      recordScanCompleted(timestamp);
    }
    expect(getTzDriftMetricsSnapshot().lastScanTimestampMs).toBe(1_700_000_000_000);

    recordScanCompleted(1_700_000_000_001);
    expect(getTzDriftMetricsSnapshot().lastScanTimestampMs).toBe(1_700_000_000_001);
  });

  it("relabels new ambiguous tuples after the 32-label budget is full", () => {
    for (let tenant = 0; tenant < 32; tenant++) {
      recordAmbiguousSlots(`tenant-${tenant}`, "warning", 1);
    }
    recordAmbiguousSlots("tenant-32", "warning", 2);
    recordAmbiguousSlots("tenant-33", "warning", 3);
    recordAmbiguousSlots("tenant-0", "warning", 4);

    const snapshot = getTzDriftMetricsSnapshot();
    expect(Object.keys(snapshot.ambiguousCounts)).toHaveLength(33);
    expect(snapshot.ambiguousCounts["tenant-0_warning"]).toBe(5);
    expect(snapshot.ambiguousCounts["tenant-31_warning"]).toBe(1);
    expect(snapshot.ambiguousCounts.__overflow__).toBe(5);
    expect(snapshot.cardinalityOverflowCounts).toEqual({
      tz_drift_ambiguous_slots: 2,
      tz_drift_missing_tz_slots: 0,
    });
  });

  it("budgets missing-timezone tuples independently", () => {
    for (let tenant = 0; tenant < 32; tenant++) {
      recordMissingTzSlots(`tenant-${tenant}`, "critical", 1);
    }
    recordMissingTzSlots("tenant-32", "critical", 2);
    recordMissingTzSlots("tenant-0", "critical", 3);
    recordAmbiguousSlots("tenant-32", "critical", 4);

    const snapshot = getTzDriftMetricsSnapshot();
    expect(snapshot.missingTzCounts.__overflow__).toBe(2);
    expect(snapshot.missingTzCounts["tenant-0_critical"]).toBe(4);
    expect(snapshot.ambiguousCounts).toEqual({ "tenant-32_critical": 4 });
    expect(snapshot.cardinalityOverflowCounts).toEqual({
      tz_drift_ambiguous_slots: 0,
      tz_drift_missing_tz_slots: 1,
    });
  });

  it("returns snapshots that cannot mutate internal state", () => {
    recordAmbiguousSlots("tenant-a", "critical", 2);
    recordMissingTzSlots("tenant-a", "warning", 3);
    const snapshot = getTzDriftMetricsSnapshot();
    snapshot.ambiguousCounts["tenant-a_critical"] = 99;
    snapshot.missingTzCounts["tenant-a_warning"] = 99;
    snapshot.cardinalityOverflowCounts.tz_drift_ambiguous_slots = 99;

    const next = getTzDriftMetricsSnapshot();
    expect(next.ambiguousCounts["tenant-a_critical"]).toBe(2);
    expect(next.missingTzCounts["tenant-a_warning"]).toBe(3);
    expect(next.cardinalityOverflowCounts.tz_drift_ambiguous_slots).toBe(0);
  });

  it("clears all counters, timestamps, and label budgets on reset", () => {
    for (let tenant = 0; tenant <= 32; tenant++) {
      recordAmbiguousSlots(`tenant-${tenant}`, "info", 1);
    }
    recordMissingTzSlots("tenant-a", "warning", 2);
    recordSlotsScanned(3);
    recordScanCompleted(1_700_000_000_000);

    resetTzDriftMetrics();
    expect(getTzDriftMetricsSnapshot()).toEqual({
      ambiguousCounts: {},
      missingTzCounts: {},
      lastScanTimestampMs: 0,
      totalScanned: 0,
      cardinalityOverflowCounts: {
        tz_drift_ambiguous_slots: 0,
        tz_drift_missing_tz_slots: 0,
      },
    });

    recordAmbiguousSlots("new-tenant", "info", 1);
    expect(getTzDriftMetricsSnapshot().ambiguousCounts).toEqual({ "new-tenant_info": 1 });
  });
});
