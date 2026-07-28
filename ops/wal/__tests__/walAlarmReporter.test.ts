/**
 * Tests for ops/wal/walAlarmReporter.ts
 *
 * Covers:
 *  - exitCodeForReport (healthy, WARNING only, CRITICAL)
 *  - formatReportText (headers, alarm lines, healthy flag)
 *  - formatReportJson (valid JSON, schema)
 *  - WalAlarmReporter.dispatch (minSeverity filtering, custom handler)
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  exitCodeForReport,
  formatReportJson,
  formatReportText,
  WalAlarmReporter,
} from "../walAlarmReporter";
import type { WalIntegrityReport } from "../walIntegrityChecker";

// ---------------------------------------------------------------------------
// Helper: build a minimal report
// ---------------------------------------------------------------------------

function makeReport(
  overrides: Partial<WalIntegrityReport> = {},
): WalIntegrityReport {
  return {
    archivePath: "/wal",
    generatedAt: "2026-07-28T09:00:00.000Z",
    totalSegments: 0,
    verifiedSegments: 0,
    corruptSegments: 0,
    gapsDetected: 0,
    duplicatesDetected: 0,
    partialSegments: 0,
    alarms: [],
    segments: [],
    healthy: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// exitCodeForReport
// ---------------------------------------------------------------------------

describe("exitCodeForReport", () => {
  it("returns 0 for a healthy report with no alarms", () => {
    expect(exitCodeForReport(makeReport())).toBe(0);
  });

  it("returns 0 for INFO-only alarms", () => {
    const report = makeReport({
      alarms: [{ severity: "INFO", code: "RESTORE_IN_PROGRESS", message: "partial" }],
    });
    expect(exitCodeForReport(report)).toBe(0);
  });

  it("returns 2 for WARNING-only alarms", () => {
    const report = makeReport({
      healthy: false,
      alarms: [{ severity: "WARNING", code: "STORAGE_TIMEOUT", message: "warn" }],
    });
    expect(exitCodeForReport(report)).toBe(2);
  });

  it("returns 3 when any CRITICAL alarm exists", () => {
    const report = makeReport({
      healthy: false,
      alarms: [
        { severity: "CRITICAL", code: "HASH_MISMATCH", message: "bad hash" },
        { severity: "WARNING", code: "STORAGE_TIMEOUT", message: "warn" },
      ],
    });
    expect(exitCodeForReport(report)).toBe(3);
  });

  it("returns 3 for CRITICAL even if RESTORE_IN_PROGRESS is also present", () => {
    const report = makeReport({
      healthy: false,
      alarms: [
        { severity: "INFO", code: "RESTORE_IN_PROGRESS", message: "partial" },
        { severity: "CRITICAL", code: "GAP_DETECTED", message: "gap" },
      ],
    });
    expect(exitCodeForReport(report)).toBe(3);
  });

  it("returns 0 for RESTORE_IN_PROGRESS (INFO severity) with no other alarms", () => {
    // RESTORE_IN_PROGRESS is INFO – should not affect exit code
    const report = makeReport({
      alarms: [
        { severity: "INFO", code: "RESTORE_IN_PROGRESS", message: "partial" },
      ],
    });
    expect(exitCodeForReport(report)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatReportText
// ---------------------------------------------------------------------------

describe("formatReportText", () => {
  it("includes archive path and generatedAt", () => {
    const text = formatReportText(makeReport({ archivePath: "/my/archive" }));
    expect(text).toContain("/my/archive");
    expect(text).toContain("2026-07-28T09:00:00.000Z");
  });

  it("shows HEALTHY for healthy report", () => {
    const text = formatReportText(makeReport({ healthy: true }));
    expect(text).toContain("HEALTHY");
  });

  it("shows UNHEALTHY for unhealthy report", () => {
    const text = formatReportText(makeReport({ healthy: false }));
    expect(text).toContain("UNHEALTHY");
  });

  it("includes alarm lines with severity prefix", () => {
    const report = makeReport({
      alarms: [
        { severity: "CRITICAL", code: "HASH_MISMATCH", message: "bad hash", segment: "seg1" },
      ],
    });
    const text = formatReportText(report);
    expect(text).toContain("[CRITICAL]");
    expect(text).toContain("[seg1]");
    expect(text).toContain("bad hash");
  });

  it("includes WARNING alarm with correct prefix", () => {
    const report = makeReport({
      alarms: [{ severity: "WARNING", code: "STORAGE_TIMEOUT", message: "timeout" }],
    });
    const text = formatReportText(report);
    expect(text).toContain("WARNING");
    expect(text).toContain("timeout");
  });

  it("includes INFO alarm with correct prefix", () => {
    const report = makeReport({
      alarms: [{ severity: "INFO", code: "RESTORE_IN_PROGRESS", message: "partial seg" }],
    });
    const text = formatReportText(report);
    expect(text).toContain("INFO");
    expect(text).toContain("partial seg");
  });

  it("shows segment counts", () => {
    const report = makeReport({
      totalSegments: 10,
      verifiedSegments: 8,
      corruptSegments: 1,
      gapsDetected: 2,
      duplicatesDetected: 1,
      partialSegments: 1,
    });
    const text = formatReportText(report);
    expect(text).toContain("10");
    expect(text).toContain("8");
    expect(text).toContain("1");
  });
});

// ---------------------------------------------------------------------------
// formatReportJson
// ---------------------------------------------------------------------------

describe("formatReportJson", () => {
  it("produces valid JSON", () => {
    const report = makeReport();
    expect(() => JSON.parse(formatReportJson(report))).not.toThrow();
  });

  it("round-trips the report", () => {
    const report = makeReport({
      totalSegments: 5,
      alarms: [
        { severity: "WARNING", code: "STORAGE_TIMEOUT", message: "slow" },
      ],
    });
    const parsed = JSON.parse(formatReportJson(report)) as WalIntegrityReport;
    expect(parsed.totalSegments).toBe(5);
    expect(parsed.alarms[0].code).toBe("STORAGE_TIMEOUT");
  });
});

// ---------------------------------------------------------------------------
// WalAlarmReporter.dispatch
// ---------------------------------------------------------------------------

describe("WalAlarmReporter", () => {
  it("calls onAlarm for each alarm by default (minSeverity=INFO)", async () => {
    const handler = jest.fn();
    const reporter = new WalAlarmReporter({ onAlarm: handler });

    const report = makeReport({
      alarms: [
        { severity: "INFO", code: "RESTORE_IN_PROGRESS", message: "info" },
        { severity: "WARNING", code: "STORAGE_TIMEOUT", message: "warn" },
        { severity: "CRITICAL", code: "HASH_MISMATCH", message: "crit" },
      ],
    });

    await reporter.dispatch(report);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("filters alarms below minSeverity=WARNING", async () => {
    const handler = jest.fn();
    const reporter = new WalAlarmReporter({
      minSeverity: "WARNING",
      onAlarm: handler,
    });

    const report = makeReport({
      alarms: [
        { severity: "INFO", code: "RESTORE_IN_PROGRESS", message: "info" },
        { severity: "WARNING", code: "STORAGE_TIMEOUT", message: "warn" },
        { severity: "CRITICAL", code: "HASH_MISMATCH", message: "crit" },
      ],
    });

    await reporter.dispatch(report);
    expect(handler).toHaveBeenCalledTimes(2);
    const calls = handler.mock.calls.map((c) => (c[0] as { severity: string }).severity);
    expect(calls).not.toContain("INFO");
  });

  it("filters alarms below minSeverity=CRITICAL", async () => {
    const handler = jest.fn();
    const reporter = new WalAlarmReporter({
      minSeverity: "CRITICAL",
      onAlarm: handler,
    });

    const report = makeReport({
      alarms: [
        { severity: "INFO", code: "RESTORE_IN_PROGRESS", message: "info" },
        { severity: "WARNING", code: "STORAGE_TIMEOUT", message: "warn" },
        { severity: "CRITICAL", code: "HASH_MISMATCH", message: "crit" },
      ],
    });

    await reporter.dispatch(report);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as { severity: string }).severity).toBe("CRITICAL");
  });

  it("dispatches nothing when report has no alarms", async () => {
    const handler = jest.fn();
    const reporter = new WalAlarmReporter({ onAlarm: handler });
    await reporter.dispatch(makeReport());
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes both alarm and report to handler", async () => {
    const handler = jest.fn();
    const reporter = new WalAlarmReporter({ onAlarm: handler });
    const report = makeReport({
      alarms: [{ severity: "CRITICAL", code: "GAP_DETECTED", message: "gap" }],
    });

    await reporter.dispatch(report);
    expect(handler.mock.calls[0][0]).toEqual(report.alarms[0]);
    expect(handler.mock.calls[0][1]).toBe(report);
  });

  it("awaits async onAlarm handlers", async () => {
    const order: number[] = [];
    const handler = jest.fn(async (_alarm: unknown) => {
      await new Promise((r) => setTimeout(r, 1));
      order.push(1);
    });

    const reporter = new WalAlarmReporter({ onAlarm: handler });
    const report = makeReport({
      alarms: [
        { severity: "INFO", code: "RESTORE_IN_PROGRESS", message: "a" },
        { severity: "WARNING", code: "STORAGE_TIMEOUT", message: "b" },
      ],
    });

    await reporter.dispatch(report);
    expect(order).toEqual([1, 1]);
  });
});
