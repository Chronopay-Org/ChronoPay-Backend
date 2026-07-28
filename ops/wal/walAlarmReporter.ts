/**
 * WAL Integrity Alarm Reporter
 *
 * Formats WalIntegrityReport output for multiple destinations:
 *   - Human-readable console output (coloured severity levels)
 *   - Structured JSON (for log aggregators / Prometheus alertmanager)
 *   - Exit-code semantics for CI/cron use
 *
 * Exit codes (mirrors scripts/check-wal-integrity.ts):
 *   0  – archive is healthy (may have INFO alarms)
 *   1  – fatal / unexpected error
 *   2  – WARNING alarms only (no CRITICALs)
 *   3  – CRITICAL alarms detected
 */

import type { WalAlarm, WalIntegrityReport } from "./walIntegrityChecker";

// ---------------------------------------------------------------------------
// Severity → exit-code mapping
// ---------------------------------------------------------------------------

export function exitCodeForReport(report: WalIntegrityReport): number {
  const hasCritical = report.alarms.some(
    (a) => a.severity === "CRITICAL" && a.code !== "RESTORE_IN_PROGRESS",
  );
  const hasWarning = report.alarms.some((a) => a.severity === "WARNING");

  if (hasCritical) return 3;
  if (hasWarning) return 2;
  return 0;
}

// ---------------------------------------------------------------------------
// Text reporter (stdout / stderr)
// ---------------------------------------------------------------------------

const SEVERITY_PREFIX: Record<WalAlarm["severity"], string> = {
  CRITICAL: "[CRITICAL]",
  WARNING:  "[ WARNING]",
  INFO:     "[   INFO ]",
};

export function formatReportText(report: WalIntegrityReport): string {
  const lines: string[] = [];

  lines.push("=".repeat(72));
  lines.push("WAL Archive Integrity Report");
  lines.push(`Generated : ${report.generatedAt}`);
  lines.push(`Archive   : ${report.archivePath}`);
  lines.push("-".repeat(72));
  lines.push(`Total segments   : ${report.totalSegments}`);
  lines.push(`Verified (hash)  : ${report.verifiedSegments}`);
  lines.push(`Corrupt          : ${report.corruptSegments}`);
  lines.push(`Partial (in-prog): ${report.partialSegments}`);
  lines.push(`Gaps detected    : ${report.gapsDetected}`);
  lines.push(`Duplicates       : ${report.duplicatesDetected}`);
  lines.push(`Status           : ${report.healthy ? "✓ HEALTHY" : "✗ UNHEALTHY"}`);

  if (report.alarms.length > 0) {
    lines.push("-".repeat(72));
    lines.push("Alarms:");
    for (const alarm of report.alarms) {
      const prefix = SEVERITY_PREFIX[alarm.severity];
      const seg = alarm.segment ? ` [${alarm.segment}]` : "";
      lines.push(`  ${prefix}${seg} ${alarm.message}`);
    }
  }

  lines.push("=".repeat(72));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON reporter
// ---------------------------------------------------------------------------

export function formatReportJson(report: WalIntegrityReport): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// Alarm dispatcher (webhook / stdout / custom handler)
// ---------------------------------------------------------------------------

export type AlarmHandler = (alarm: WalAlarm, report: WalIntegrityReport) => void | Promise<void>;

export interface ReporterOptions {
  /**
   * Only dispatch alarms at or above this minimum severity.
   * "INFO" = all alarms, "WARNING" = warnings + criticals, "CRITICAL" = criticals only.
   */
  minSeverity?: WalAlarm["severity"];

  /** Custom handler called once per alarm. */
  onAlarm?: AlarmHandler;
}

const SEVERITY_RANK: Record<WalAlarm["severity"], number> = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
};

export class WalAlarmReporter {
  private readonly options: Required<ReporterOptions>;

  constructor(options: ReporterOptions = {}) {
    this.options = {
      minSeverity: options.minSeverity ?? "INFO",
      onAlarm:
        options.onAlarm ??
        ((alarm) => {
          // default: write to stderr so stdout stays clean for JSON output
          const prefix = SEVERITY_PREFIX[alarm.severity];
          const seg = alarm.segment ? ` [${alarm.segment}]` : "";
          process.stderr.write(`${prefix}${seg} ${alarm.message}\n`);
        }),
    };
  }

  async dispatch(report: WalIntegrityReport): Promise<void> {
    const minRank = SEVERITY_RANK[this.options.minSeverity];
    for (const alarm of report.alarms) {
      if (SEVERITY_RANK[alarm.severity] >= minRank) {
        await Promise.resolve(this.options.onAlarm(alarm, report));
      }
    }
  }
}
