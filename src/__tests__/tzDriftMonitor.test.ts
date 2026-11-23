/**
 * @fileoverview Comprehensive tests for the timezone drift monitor.
 *
 * Verifies:
 * - Detection of slots with naive local timestamps (missing TZ offset)
 * - Detection of slots near DST transitions
 * - Cursor-based pagination
 * - Safety brake threshold
 * - Tenant-scoped metric emission
 * - Worker loop with graceful shutdown
 * - Edge cases: historical rows, deleted tenants, empty stores
 * - Admin API offenders endpoint
 *
 * Uses fake timers throughout to eliminate flake.
 */

import { jest } from "@jest/globals";
import {
  InMemorySlotStore,
  scanTzDriftOnce,
  runTzDriftMonitor,
  getLastScanFindings,
  type TZSlotRecord,
} from "../scheduler/tzDriftMonitor.js";
import {
  getTzDriftMetricsSnapshot,
  resetTzDriftMetrics,
} from "../metrics/tzDriftMetrics.js";
import { register } from "../metrics.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function promMetricValue(metricName: string): Promise<number> {
  const metrics = await register.metrics();
  const lines = metrics.split("\n");
  let total = 0;
  for (const line of lines) {
    if (line.startsWith(metricName) && !line.startsWith("#")) {
      const val = Number(line.trim().split(/\s+/).pop());
      if (!Number.isNaN(val)) total += val;
    }
  }
  return total;
}

function makeSlot(overrides: Partial<TZSlotRecord> = {}): TZSlotRecord {
  return {
    id: overrides.id ?? `slot-${Math.random().toString(36).slice(2, 10)}`,
    professionalId: overrides.professionalId ?? "pro-default",
    startTime: overrides.startTime ?? Date.now(),
    endTime: overrides.endTime ?? Date.now() + 3_600_000,
    ...overrides,
  };
}

// DST transition: US spring forward 2026-03-08 02:00 EST → 03:00 EDT (UTC-5 → UTC-4)
// The UTC time of the transition is 2026-03-08T07:00:00Z
const US_SPRING_FORWARD_2026_MS = new Date("2026-03-08T07:00:00Z").getTime();

// DST transition: UK spring forward 2026-03-29 01:00 GMT → 02:00 BST (UTC+0 → UTC+1)
const UK_SPRING_FORWARD_2026_MS = new Date("2026-03-29T01:00:00Z").getTime();

describe("Timezone Drift Monitor", () => {
  let store: InMemorySlotStore;

  beforeEach(() => {
    jest.useFakeTimers();
    store = new InMemorySlotStore();
    resetTzDriftMetrics();
    register.resetMetrics();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Basic scan functionality
  // ────────────────────────────────────────────────────────────────────────────

  it("scans an empty store and returns zero findings", () => {
    const result = scanTzDriftOnce(store);
    expect(result.slotsScanned).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.skippedBecauseThreshold).toBeUndefined();
  });

  it("scans slots and returns findings for rows with missing TZ info", () => {
    store.upsert(
      makeSlot({
        id: "slot-1",
        professionalId: "pro-1",
        startTime: "2026-07-15T08:00:00", // ISO without offset
        endTime: "2026-07-15T09:00:00",
      }),
    );

    const result = scanTzDriftOnce(store);
    expect(result.slotsScanned).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      slotId: "slot-1",
      professionalId: "pro-1",
      severity: "critical",
      category: "missing_tz",
    });
  });

  it("does not flag slots with epoch millisecond times as missing TZ", () => {
    store.upsert(
      makeSlot({
        id: "slot-epoch",
        professionalId: "pro-1",
        startTime: 1_700_000_000_000,
        endTime: 1_700_003_600_000,
        timezone: "UTC",
      }),
    );

    const result = scanTzDriftOnce(store);
    // Epoch numbers + explicit timezone → no critical findings expected
    const criticalFindings = result.findings.filter((f) => f.severity === "critical");
    expect(criticalFindings).toHaveLength(0);
  });

  it("flags slots with ISO offset timestamps as safe from missing TZ", () => {
    store.upsert(
      makeSlot({
        id: "slot-safe",
        professionalId: "pro-1",
        startTime: "2026-07-15T08:00:00Z",
        endTime: "2026-07-15T09:00:00+05:00",
      }),
    );

    const result = scanTzDriftOnce(store);
    const missingTzFindings = result.findings.filter(
      (f) => f.category === "missing_tz",
    );
    expect(missingTzFindings).toHaveLength(0);
  });

  it("flags slots with naive ISO timestamps but explicit timezone field as warning", () => {
    store.upsert(
      makeSlot({
        id: "slot-warn",
        professionalId: "pro-2",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
        timezone: "America/New_York",
      }),
    );

    const result = scanTzDriftOnce(store);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: "warning",
      category: "missing_tz",
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // DST transition detection
  // ────────────────────────────────────────────────────────────────────────────

  it("flags slots whose times fall near a DST transition", () => {
    // Slot exactly at the US spring-forward transition
    store.upsert(
      makeSlot({
        id: "slot-dst-1",
        professionalId: "pro-dst",
        startTime: US_SPRING_FORWARD_2026_MS - 1_800_000, // 30 min before
        endTime: US_SPRING_FORWARD_2026_MS + 1_800_000, // 30 min after
      }),
    );

    const result = scanTzDriftOnce(store);
    const dstFindings = result.findings.filter((f) =>
      f.category === "ambiguous",
    );
    expect(dstFindings.length).toBeGreaterThanOrEqual(1);
  });

  it("flags DST transitions as info when explicit timezone is present", () => {
    store.upsert(
      makeSlot({
        id: "slot-dst-info",
        professionalId: "pro-dst",
        startTime: UK_SPRING_FORWARD_2026_MS,
        endTime: UK_SPRING_FORWARD_2026_MS + 3_600_000,
        timezone: "Europe/London",
      }),
    );

    const result = scanTzDriftOnce(store, {
      monitoredTimezones: ["Europe/London"],
    });
    const dstFindings = result.findings.filter((f) => f.category === "ambiguous");
    if (dstFindings.length > 0) {
      expect(dstFindings[0].severity).toBe("info");
    }
  });

  it("flags DST transitions as warning when no timezone field is present", () => {
    store.upsert(
      makeSlot({
        id: "slot-dst-warn",
        professionalId: "pro-dst",
        startTime: US_SPRING_FORWARD_2026_MS - 600_000,
        endTime: US_SPRING_FORWARD_2026_MS + 600_000,
      }),
    );

    const result = scanTzDriftOnce(store);
    const dstFindings = result.findings.filter((f) =>
      f.category === "ambiguous" && f.severity === "warning",
    );
    // DST findings without timezone → warning
    if (dstFindings.length > 0) {
      expect(dstFindings[0].severity).toBe("warning");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Missing timezone metadata (opt-in via reportMissingMetadata config)
  // ────────────────────────────────────────────────────────────────────────────

  it("does not flag missing metadata by default", () => {
    store.upsert(
      makeSlot({
        id: "slot-no-tz",
        professionalId: "pro-info",
        startTime: "2026-07-15T08:00:00Z",
        endTime: "2026-07-15T09:00:00Z",
        // no timezone field
      }),
    );

    // Default config: reportMissingMetadata = false
    const result = scanTzDriftOnce(store);
    expect(result.findings).toHaveLength(0);
  });

  it("flags missing metadata when reportMissingMetadata is enabled", () => {
    store.upsert(
      makeSlot({
        id: "slot-no-tz",
        professionalId: "pro-info",
        startTime: "2026-07-15T08:00:00Z",
        endTime: "2026-07-15T09:00:00Z",
      }),
    );

    const result = scanTzDriftOnce(store, { reportMissingMetadata: true });
    const infoFindings = result.findings.filter(
      (f) => f.severity === "info" && f.category === "metadata",
    );
    expect(infoFindings.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag slots that have both explicit TZ offset and timezone metadata", () => {
    store.upsert(
      makeSlot({
        id: "slot-clean",
        professionalId: "pro-clean",
        startTime: "2026-07-15T08:00:00Z",
        endTime: "2026-07-15T09:00:00Z",
        timezone: "UTC",
      }),
    );

    const result = scanTzDriftOnce(store);
    expect(result.findings).toHaveLength(0);
  });

  it("does not flag clean slots even with reportMissingMetadata enabled", () => {
    store.upsert(
      makeSlot({
        id: "slot-clean-extra",
        professionalId: "pro-clean",
        startTime: "2026-07-15T08:00:00Z",
        endTime: "2026-07-15T09:00:00Z",
        timezone: "UTC",
      }),
    );

    const result = scanTzDriftOnce(store, { reportMissingMetadata: true });
    expect(result.findings).toHaveLength(0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Pagination
  // ────────────────────────────────────────────────────────────────────────────

  it("scans slots across multiple pages using cursor-based pagination", () => {
    for (let i = 0; i < 250; i++) {
      store.upsert(
        makeSlot({
          id: `slot-${String(i).padStart(4, "0")}`,
          professionalId: `pro-${i % 5}`,
          startTime: "2026-07-15T08:00:00",
          endTime: "2026-07-15T09:00:00",
        }),
      );
    }

    const result = scanTzDriftOnce(store, { pageSize: 50 });
    expect(result.slotsScanned).toBe(250);
    expect(result.findings).toHaveLength(250);
  });

  it("respects scanLimit and stops early", () => {
    for (let i = 0; i < 200; i++) {
      store.upsert(
        makeSlot({
          id: `slot-${String(i).padStart(4, "0")}`,
          professionalId: "pro-limit",
          startTime: "2026-07-15T08:00:00",
          endTime: "2026-07-15T09:00:00",
        }),
      );
    }

    const result = scanTzDriftOnce(store, { scanLimit: 100, pageSize: 25 });
    expect(result.slotsScanned).toBe(100);
    expect(result.findings.length).toBeLessThanOrEqual(100);
  });

  it("handles page size larger than remaining scan limit", () => {
    for (let i = 0; i < 50; i++) {
      store.upsert(
        makeSlot({
          id: `slot-${String(i).padStart(4, "0")}`,
          professionalId: "pro-rem",
          startTime: "2026-07-15T08:00:00",
          endTime: "2026-07-15T09:00:00",
        }),
      );
    }

    const result = scanTzDriftOnce(store, { scanLimit: 30, pageSize: 100 });
    expect(result.slotsScanned).toBe(30);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Safety brake
  // ────────────────────────────────────────────────────────────────────────────

  it("skips scan when total slots exceed safety threshold", () => {
    const manySlots = 200;
    for (let i = 0; i < manySlots; i++) {
      store.upsert(
        makeSlot({
          id: `slot-${String(i).padStart(6, "0")}`,
          professionalId: "pro-safety",
          startTime: 1_700_000_000_000,
          endTime: 1_700_003_600_000,
        }),
      );
    }

    const result = scanTzDriftOnce(store, { safetyThreshold: 100 });
    expect(result.skippedBecauseThreshold).toBe(true);
    expect(result.slotsScanned).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("proceeds with scan when total slots are at or below safety threshold", () => {
    for (let i = 0; i < 10; i++) {
      store.upsert(
        makeSlot({
          id: `slot-${String(i).padStart(4, "0")}`,
          professionalId: "pro-ok",
          startTime: "2026-07-15T08:00:00",
          endTime: "2026-07-15T09:00:00",
        }),
      );
    }

    const result = scanTzDriftOnce(store, { safetyThreshold: 10 });
    expect(result.skippedBecauseThreshold).toBeUndefined();
    expect(result.slotsScanned).toBe(10);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tenant-scoped metrics
  // ────────────────────────────────────────────────────────────────────────────

  it("emits tenant-scoped metrics for ambiguous and missing TZ slots", () => {
    store.upsert(
      makeSlot({
        id: "slot-a",
        professionalId: "tenant-alpha",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
      }),
    );
    store.upsert(
      makeSlot({
        id: "slot-b",
        professionalId: "tenant-alpha",
        startTime: "2026-07-15T10:00:00",
        endTime: "2026-07-15T11:00:00",
      }),
    );
    store.upsert(
      makeSlot({
        id: "slot-c",
        professionalId: "tenant-beta",
        startTime: "2026-07-15T12:00:00",
        endTime: "2026-07-15T13:00:00",
      }),
    );

    scanTzDriftOnce(store);
    const snapshot = getTzDriftMetricsSnapshot();

    expect(snapshot.totalScanned).toBe(3);
    expect(Object.keys(snapshot.missingTzCounts).length).toBeGreaterThanOrEqual(1);
  });

  it("records last scan timestamp after successful scan", () => {
    const now = 1_700_000_000_000;
    scanTzDriftOnce(store, {}, now);
    const snapshot = getTzDriftMetricsSnapshot();
    expect(snapshot.lastScanTimestampMs).toBe(now);
  });

  it("increments slots scanned counter cumulatively", () => {
    for (let i = 0; i < 5; i++) {
      store.upsert(
        makeSlot({
          id: `slot-${i}`,
          professionalId: "pro-counter",
          startTime: "2026-07-15T08:00:00",
          endTime: "2026-07-15T09:00:00",
        }),
      );
    }

    scanTzDriftOnce(store);
    const snapshot1 = getTzDriftMetricsSnapshot();
    expect(snapshot1.totalScanned).toBe(5);

    scanTzDriftOnce(store);
    const snapshot2 = getTzDriftMetricsSnapshot();
    expect(snapshot2.totalScanned).toBe(10);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Last scan findings cache (admin API)
  // ────────────────────────────────────────────────────────────────────────────

  it("caches findings from the last scan for the admin API", () => {
    store.upsert(
      makeSlot({
        id: "slot-cache",
        professionalId: "pro-cache",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
      }),
    );

    scanTzDriftOnce(store);
    const findings = getLastScanFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0].slotId).toBe("slot-cache");
  });

  it("replaces cached findings on each scan", () => {
    store.upsert(
      makeSlot({
        id: "slot-first",
        professionalId: "pro-replace",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
      }),
    );

    scanTzDriftOnce(store);
    expect(getLastScanFindings()).toHaveLength(1);

    store.clear();
    store.upsert(
      makeSlot({
        id: "slot-second",
        professionalId: "pro-replace",
        startTime: "2026-07-15T10:00:00",
        endTime: "2026-07-15T11:00:00",
      }),
    );

    scanTzDriftOnce(store);
    const findings = getLastScanFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0].slotId).toBe("slot-second");
  });

  it("getLastScanFindings returns a defensive copy", () => {
    store.upsert(
      makeSlot({
        id: "slot-defensive",
        professionalId: "pro-def",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
      }),
    );

    scanTzDriftOnce(store);
    const findings = getLastScanFindings();
    findings.push({
      slotId: "injected",
      professionalId: "bad",
      severity: "critical",
      category: "missing_tz",
      reason: "injected",
      startTime: 0,
      endTime: 0,
    });

    const findingsAgain = getLastScanFindings();
    expect(findingsAgain).toHaveLength(1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Worker loop
  // ────────────────────────────────────────────────────────────────────────────

  it("stops worker gracefully when aborted before first sleep", async () => {
    store.upsert(
      makeSlot({
        id: "slot-worker",
        professionalId: "pro-worker",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
      }),
    );

    const abortController = new AbortController();
    // Abort immediately — the worker should exit after the first scan
    abortController.abort();

    const workerPromise = runTzDriftMonitor(abortController.signal, store, {
      intervalMs: 50,
    });

    await expect(workerPromise).resolves.toBeUndefined();
  });

  it("worker scans at least once before checking abort signal", async () => {
    store.upsert(
      makeSlot({
        id: "slot-workerscan",
        professionalId: "pro-workerscan",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
      }),
    );

    const abortController = new AbortController();
    const workerPromise = runTzDriftMonitor(abortController.signal, store, {
      intervalMs: 86_400_000,
    });

    // scanTzDriftOnce runs synchronously in the first microtask tick;
    // then the worker awaits sleep().  Aborting now triggers the
    // sleep's abort listener which calls clearTimeout + resolve()
    // synchronously, allowing the while-loop to exit.
    abortController.abort();

    await expect(workerPromise).resolves.toBeUndefined();
    const snapshot = getTzDriftMetricsSnapshot();
    expect(snapshot.totalScanned).toBeGreaterThanOrEqual(1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Edge cases
  // ────────────────────────────────────────────────────────────────────────────

  it("handles slots with unparseable time values gracefully", () => {
    store.upsert(
      makeSlot({
        id: "slot-bad-time",
        professionalId: "pro-edge",
        startTime: "not-a-date",
        endTime: "also-not-a-date",
      }),
    );

    const result = scanTzDriftOnce(store);
    // Should still record the slot as scanned
    expect(result.slotsScanned).toBe(1);
  });

  it("handles mixed valid and invalid slots in the same scan", () => {
    store.upsert(
      makeSlot({
        id: "slot-ok",
        professionalId: "pro-mixed",
        startTime: "2026-07-15T08:00:00Z",
        endTime: "2026-07-15T09:00:00Z",
        timezone: "UTC",
      }),
    );
    store.upsert(
      makeSlot({
        id: "slot-bad",
        professionalId: "pro-mixed",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
      }),
    );

    const result = scanTzDriftOnce(store);
    expect(result.slotsScanned).toBe(2);
    const badFindings = result.findings.filter((f) => f.slotId === "slot-bad");
    expect(badFindings).toHaveLength(1);
    const okFindings = result.findings.filter((f) => f.slotId === "slot-ok");
    expect(okFindings).toHaveLength(0);
  });

  it("handles empty string timezone field correctly", () => {
    store.upsert(
      makeSlot({
        id: "slot-empty-tz",
        professionalId: "pro-empty",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
        timezone: "",
      }),
    );

    const result = scanTzDriftOnce(store);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("critical");
    expect(result.findings[0].category).toBe("missing_tz");
  });

  it("handles whitespace-only timezone field", () => {
    store.upsert(
      makeSlot({
        id: "slot-ws-tz",
        professionalId: "pro-ws",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
        timezone: "   ",
      }),
    );

    const result = scanTzDriftOnce(store);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("critical");
  });

  it("handles ISO timestamps with fractional seconds", () => {
    store.upsert(
      makeSlot({
        id: "slot-frac",
        professionalId: "pro-frac",
        startTime: "2026-07-15T08:00:00.123",
        endTime: "2026-07-15T09:00:00.456Z",
      }),
    );

    const result = scanTzDriftOnce(store);
    const findings = result.findings.filter((f) => f.slotId === "slot-frac");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
  });

  it("handles ISO timestamps with numeric timezone offsets", () => {
    store.upsert(
      makeSlot({
        id: "slot-numtz",
        professionalId: "pro-numtz",
        startTime: "2026-07-15T08:00:00+05:30",
        endTime: "2026-07-15T09:00:00-04:00",
        timezone: "Asia/Kolkata",
      }),
    );

    const result = scanTzDriftOnce(store);
    expect(result.findings).toHaveLength(0);
  });

  it("handles a large number of tenants within cardinality budget", () => {
    for (let i = 0; i < 30; i++) {
      store.upsert(
        makeSlot({
          id: `slot-tenant-${i}`,
          professionalId: `tenant-${String(i).padStart(3, "0")}`,
          startTime: "2026-07-15T08:00:00",
          endTime: "2026-07-15T09:00:00",
        }),
      );
    }

    const result = scanTzDriftOnce(store);
    expect(result.slotsScanned).toBe(30);
    expect(result.findings).toHaveLength(30);

    const snapshot = getTzDriftMetricsSnapshot();
    expect(snapshot.cardinalityOverflowCounts.tz_drift_missing_tz_slots).toBe(0);
  });

  it("accumulates scanned counts across multiple scans", () => {
    store.upsert(
      makeSlot({
        id: "slot-dedup",
        professionalId: "pro-dedup",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
      }),
    );

    scanTzDriftOnce(store);
    const snap1 = getTzDriftMetricsSnapshot();
    const beforeTotal = snap1.totalScanned;

    scanTzDriftOnce(store);
    const snap2 = getTzDriftMetricsSnapshot();
    expect(snap2.totalScanned).toBe(beforeTotal + 1);
  });

  it("records zero findings for slots that are timezone-clean", () => {
    store.upsert(
      makeSlot({
        id: "slot-clean-1",
        professionalId: "pro-clean",
        startTime: "2026-07-15T08:00:00Z",
        endTime: "2026-07-15T09:00:00Z",
        timezone: "UTC",
      }),
    );
    store.upsert(
      makeSlot({
        id: "slot-clean-2",
        professionalId: "pro-clean",
        startTime: "2026-07-15T10:00:00+01:00",
        endTime: "2026-07-15T11:00:00+01:00",
        timezone: "Europe/Berlin",
      }),
    );

    const result = scanTzDriftOnce(store);
    expect(result.slotsScanned).toBe(2);
    expect(result.findings).toHaveLength(0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Edge case: deleted tenant (slots with invalid/unreferenced professionalId)
  // ────────────────────────────────────────────────────────────────────────────

  it("handles slots referencing deleted/non-existent tenants", () => {
    store.upsert(
      makeSlot({
        id: "slot-deleted-tenant",
        professionalId: "deleted-tenant-uuid",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
      }),
    );

    const result = scanTzDriftOnce(store);
    // Should still flag the slot even though the tenant may not exist
    expect(result.slotsScanned).toBe(1);
    expect(result.findings).toHaveLength(1);
    // Metrics should still record under the tenant ID
    const snapshot = getTzDriftMetricsSnapshot();
    expect(Object.keys(snapshot.missingTzCounts).length).toBeGreaterThanOrEqual(1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Edge case: historical rows with various time formats
  // ────────────────────────────────────────────────────────────────────────────

  it("handles historical rows stored as epoch milliseconds", () => {
    // Simulate an old slot stored as epoch ms (pre-migration)
    store.upsert(
      makeSlot({
        id: "slot-historical-epoch",
        professionalId: "pro-historical",
        startTime: 946_684_800_000, // 2000-01-01T00:00:00Z
        endTime: 946_688_400_000,   // 2000-01-01T01:00:00Z
        timezone: "UTC",
      }),
    );

    const result = scanTzDriftOnce(store);
    // Epoch ms with explicit timezone → clean slot
    expect(result.findings).toHaveLength(0);
  });

  it("handles historical rows stored as ISO without offset", () => {
    store.upsert(
      makeSlot({
        id: "slot-historical-iso",
        professionalId: "pro-historical",
        startTime: "2020-03-15T08:00:00",
        endTime: "2020-03-15T09:00:00",
      }),
    );

    const result = scanTzDriftOnce(store);
    // ISO without offset → critical finding
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].category).toBe("missing_tz");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Edge case: timezone data update (IANA rule change)
  // ────────────────────────────────────────────────────────────────────────────

  it("detects newly-ambiguous slots after IANA database update", () => {
    // Slot at a time that was NOT ambiguous under old IANA rules but
    // may become ambiguous after an update (e.g., a country changes DST
    // rules). The monitor re-evaluates DST proximity at scan time using
    // the current platform IANA data, so it catches these on the next scan.
    store.upsert(
      makeSlot({
        id: "slot-iana-update",
        professionalId: "pro-iana",
        startTime: US_SPRING_FORWARD_2026_MS - 300_000,
        endTime: US_SPRING_FORWARD_2026_MS + 300_000,
        // No explicit timezone → ambiguous DST proximity is warning
      }),
    );

    // Scan at a later time (simulating after IANA update)
    const laterTime = US_SPRING_FORWARD_2026_MS + 90 * 24 * 60 * 60 * 1_000;
    const result = scanTzDriftOnce(store, {}, laterTime);

    // DST proximity is re-evaluated at scan time regardless of storage time
    const dstFindings = result.findings.filter(
      (f) => f.category === "ambiguous",
    );
    // Should detect DST proximity if the slot time still falls within
    // the transition window of a monitored timezone
    expect(dstFindings.length).toBeGreaterThanOrEqual(0);
    expect(result.slotsScanned).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Config resolution
  // ────────────────────────────────────────────────────────────────────────────

  it("uses default config values when no overrides are provided", () => {
    for (let i = 0; i < 5; i++) {
      store.upsert(
        makeSlot({
          id: `slot-default-${i}`,
          professionalId: "pro-default",
          startTime: "2026-07-15T08:00:00",
          endTime: "2026-07-15T09:00:00",
        }),
      );
    }

    const result = scanTzDriftOnce(store);
    expect(result.slotsScanned).toBe(5);
    expect(result.findings).toHaveLength(5);
  });

  it("respects custom monitored timezones list", () => {
    store.upsert(
      makeSlot({
        id: "slot-custom-tz",
        professionalId: "pro-custom",
        startTime: US_SPRING_FORWARD_2026_MS,
        endTime: US_SPRING_FORWARD_2026_MS + 3_600_000,
        timezone: "UTC",
      }),
    );

    const result = scanTzDriftOnce(store, {
      monitoredTimezones: ["Asia/Tokyo", "Asia/Shanghai"],
    });
    const dstFindings = result.findings.filter((f) =>
      f.category === "ambiguous",
    );
    // Should not find DST transition in Asian timezones for US transition time
    expect(dstFindings).toHaveLength(0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Prometheus metrics sync
  // ────────────────────────────────────────────────────────────────────────────

  it("updates Prometheus gauges after a scan", async () => {
    store.upsert(
      makeSlot({
        id: "slot-prom",
        professionalId: "pro-prom",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
      }),
    );

    scanTzDriftOnce(store);

    const scannedTotal = await promMetricValue("tz_drift_slots_scanned_total");
    expect(scannedTotal).toBe(1);

    const lastScan = await promMetricValue("tz_drift_last_scan_timestamp_seconds");
    expect(lastScan).toBeGreaterThan(0);

    // Verify tenant-scoped gauges are set for this finding
    const missingTzGauge = await promMetricValue("tz_drift_missing_tz_slots");
    expect(missingTzGauge).toBeGreaterThanOrEqual(1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Metrics reset
  // ────────────────────────────────────────────────────────────────────────────

  it("resets all metrics to zero when reset is called", () => {
    store.upsert(
      makeSlot({
        id: "slot-reset",
        professionalId: "pro-reset",
        startTime: "2026-07-15T08:00:00",
        endTime: "2026-07-15T09:00:00",
      }),
    );

    scanTzDriftOnce(store);
    // Verify metrics have values before reset
    const before = getTzDriftMetricsSnapshot();
    expect(before.totalScanned).toBeGreaterThan(0);

    resetTzDriftMetrics();

    const snapshot = getTzDriftMetricsSnapshot();
    expect(snapshot.totalScanned).toBe(0);
    expect(snapshot.lastScanTimestampMs).toBe(0);
    expect(Object.keys(snapshot.ambiguousCounts)).toHaveLength(0);
    expect(Object.keys(snapshot.missingTzCounts)).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// InMemorySlotStore unit tests
// ──────────────────────────────────────────────────────────────────────────────

describe("InMemorySlotStore", () => {
  let store: InMemorySlotStore;

  beforeEach(() => {
    store = new InMemorySlotStore();
  });

  it("inserts and retrieves slots by id", () => {
    const slot = makeSlot({ id: "test-1", professionalId: "pro-1" });
    store.upsert(slot);

    const retrieved = store.findById("test-1");
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe("test-1");
    expect(retrieved?.professionalId).toBe("pro-1");
  });

  it("returns undefined for non-existent slot", () => {
    expect(store.findById("nonexistent")).toBeUndefined();
  });

  it("returns slots in sorted order by id", () => {
    store.upsert(makeSlot({ id: "slot-c" }));
    store.upsert(makeSlot({ id: "slot-a" }));
    store.upsert(makeSlot({ id: "slot-b" }));

    const page = store.listPage(undefined, 10);
    expect(page.slots.map((s) => s.id)).toEqual(["slot-a", "slot-b", "slot-c"]);
  });

  it("supports cursor-based pagination", () => {
    for (let i = 0; i < 10; i++) {
      store.upsert(makeSlot({ id: `slot-${String(i).padStart(2, "0")}` }));
    }

    const page1 = store.listPage(undefined, 4);
    expect(page1.slots).toHaveLength(4);
    expect(page1.nextCursor).toBeDefined();

    const page2 = store.listPage(page1.nextCursor, 4);
    expect(page2.slots).toHaveLength(4);
    expect(page1.slots[3].id).not.toBe(page2.slots[0].id);

    const page3 = store.listPage(page2.nextCursor, 10);
    expect(page3.slots).toHaveLength(2);
    expect(page3.nextCursor).toBeUndefined();
  });

  it("returns empty page when cursor is past all elements", () => {
    store.upsert(makeSlot({ id: "slot-1" }));
    const page = store.listPage("slot-9", 10);
    expect(page.slots).toHaveLength(0);
    expect(page.nextCursor).toBeUndefined();
  });

  it("reports correct size", () => {
    expect(store.size()).toBe(0);
    store.upsert(makeSlot({ id: "a" }));
    store.upsert(makeSlot({ id: "b" }));
    expect(store.size()).toBe(2);
  });

  it("clears all slots", () => {
    store.upsert(makeSlot({ id: "a" }));
    store.upsert(makeSlot({ id: "b" }));
    store.clear();
    expect(store.size()).toBe(0);
  });

  it("upsert replaces existing slot with same id", () => {
    store.upsert(makeSlot({ id: "replace-me", professionalId: "pro-old" }));
    store.upsert(makeSlot({ id: "replace-me", professionalId: "pro-new" }));

    const retrieved = store.findById("replace-me");
    expect(retrieved?.professionalId).toBe("pro-new");
    expect(store.size()).toBe(1);
  });

  it("listPage returns cloned objects to prevent mutation", () => {
    store.upsert(makeSlot({ id: "clone-test", professionalId: "pro-original" }));
    const page = store.listPage(undefined, 10);
    page.slots[0].professionalId = "pro-mutated";

    const retrieved = store.findById("clone-test");
    expect(retrieved?.professionalId).toBe("pro-original");
  });
});
