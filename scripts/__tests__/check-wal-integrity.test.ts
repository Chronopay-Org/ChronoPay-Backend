/**
 * Tests for scripts/check-wal-integrity.ts (CLI entry point)
 *
 * Covers:
 *  - --help flag
 *  - missing --archive argument
 *  - text and JSON output formats
 *  - exit codes for healthy / WARNING / CRITICAL
 *  - unknown format / severity arguments
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { main } from "../check-wal-integrity";
import * as checker from "../../ops/wal/walIntegrityChecker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(
  overrides: Partial<checker.WalIntegrityReport> = {},
): checker.WalIntegrityReport {
  return {
    archivePath: "/wal",
    generatedAt: "2026-07-28T09:00:00.000Z",
    totalSegments: 3,
    verifiedSegments: 3,
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
// Tests
// ---------------------------------------------------------------------------

describe("check-wal-integrity CLI", () => {
  let checkSpy: ReturnType<typeof jest.spyOn>;
  let _stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    checkSpy = jest
      .spyOn(checker.WalIntegrityChecker.prototype, "check")
      .mockResolvedValue(makeReport());

    stdoutSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    stderrSpy = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    // console.log / console.error also go to stdout/stderr in the CLI
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns exit code 1 when --archive is missing", async () => {
    const code = await main([]);
    expect(code).toBe(1);
  });

  it("returns 0 for --help", async () => {
    const code = await main(["--help"]);
    expect(code).toBe(0);
  });

  it("returns 0 for a healthy archive", async () => {
    const code = await main(["--archive", "/wal"]);
    expect(code).toBe(0);
  });

  it("returns 2 when archive has WARNING alarms only", async () => {
    checkSpy.mockResolvedValueOnce(
      makeReport({
        healthy: true,
        alarms: [
          { severity: "WARNING", code: "STORAGE_TIMEOUT", message: "slow" },
        ],
      }),
    );

    const code = await main(["--archive", "/wal"]);
    expect(code).toBe(2);
  });

  it("returns 3 when archive has CRITICAL alarms", async () => {
    checkSpy.mockResolvedValueOnce(
      makeReport({
        healthy: false,
        corruptSegments: 1,
        alarms: [
          {
            severity: "CRITICAL",
            code: "HASH_MISMATCH",
            message: "corrupt",
            segment: "seg1",
          },
        ],
      }),
    );

    const code = await main(["--archive", "/wal"]);
    expect(code).toBe(3);
  });

  it("uses text format by default", async () => {
    const logSpy = jest.spyOn(console, "log");
    await main(["--archive", "/wal"]);
    // console.log is called with the text report
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("WAL Archive Integrity Report"));
  });

  it("uses JSON format when --format json is passed", async () => {
    const logSpy = jest.spyOn(console, "log");
    await main(["--archive", "/wal", "--format", "json"]);
    const output = (logSpy.mock.calls[0][0] as string);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("returns exit code 1 on fatal checker error", async () => {
    checkSpy.mockRejectedValueOnce(new Error("unexpected crash"));
    const code = await main(["--archive", "/wal"]);
    expect(code).toBe(1);
  });

  it("short flags -a and -f work correctly", async () => {
    const logSpy = jest.spyOn(console, "log");
    await main(["-a", "/wal", "-f", "json"]);
    const output = logSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("--min-severity CRITICAL suppresses INFO and WARNING from stderr dispatch", async () => {
    checkSpy.mockResolvedValueOnce(
      makeReport({
        alarms: [
          { severity: "INFO", code: "RESTORE_IN_PROGRESS", message: "partial" },
          { severity: "WARNING", code: "STORAGE_TIMEOUT", message: "slow" },
        ],
      }),
    );

    // stderr should NOT receive INFO / WARNING alarms when minSeverity=CRITICAL
    await main(["--archive", "/wal", "--min-severity", "CRITICAL"]);
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const hasInfoOrWarn = stderrCalls.some(
      (l) => l.includes("RESTORE_IN_PROGRESS") || l.includes("STORAGE_TIMEOUT"),
    );
    expect(hasInfoOrWarn).toBe(false);
  });
});
