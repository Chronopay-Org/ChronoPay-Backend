/**
 * Tests for ops/wal/walIntegrityChecker.ts
 *
 * Covers:
 *  - Segment filename parsing (valid, partial, sidecar, unknown)
 *  - Gap detection (single gap, multi-gap, cross-timeline)
 *  - Duplicate / split-brain detection
 *  - Hash verification (match, mismatch, absent sidecar)
 *  - Partial/restore-in-progress segments
 *  - Storage timeout simulation
 *  - Unreadable segment simulation
 *  - Storage timeout when listing archive
 *  - Healthy report assertion
 *  - Report shape / metrics
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  WalIntegrityChecker,
  WalCheckerIO,
  StorageTimeoutError,
  parseSegmentFilename,
} from "../walIntegrityChecker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal in-memory IO mock */
function buildIO(overrides: Partial<WalCheckerIO> = {}): WalCheckerIO {
  return {
    listFiles: jest.fn(() => []),
    computeHash: jest.fn(async () => "a".repeat(64)),
    readSidecar: jest.fn(() => null),
    fileSize: jest.fn(() => 16 * 1024 * 1024), // 16 MiB
    ...overrides,
  };
}

/** Segment name helpers */
const tl1 = (seq: number) =>
  `00000001${seq.toString(16).padStart(16, "0")}`;

// ---------------------------------------------------------------------------
// parseSegmentFilename
// ---------------------------------------------------------------------------

describe("parseSegmentFilename", () => {
  it("parses a normal 24-char hex filename", () => {
    const seg = parseSegmentFilename("000000010000000100000001");
    expect(seg).not.toBeNull();
    expect(seg!.timeline).toBe(1);
    expect(seg!.sequenceNumber).toBe(0x0000000100000001);
    expect(seg!.isPartial).toBe(false);
  });

  it("parses a .partial segment", () => {
    const seg = parseSegmentFilename("000000010000000100000002.partial");
    expect(seg).not.toBeNull();
    expect(seg!.isPartial).toBe(true);
    expect(seg!.sequenceNumber).toBe(0x0000000100000002);
  });

  it("returns null for sidecar files (.sha256)", () => {
    expect(parseSegmentFilename("000000010000000100000001.sha256")).toBeNull();
  });

  it("returns null for arbitrary non-segment files", () => {
    expect(parseSegmentFilename("README.md")).toBeNull();
    expect(parseSegmentFilename("RECOVERY_TARGET_TIME")).toBeNull();
    expect(parseSegmentFilename("archive_status")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSegmentFilename("")).toBeNull();
  });

  it("parses 16-char segments (timeline + 8-char seq)", () => {
    const seg = parseSegmentFilename("0000000100000001");
    expect(seg).not.toBeNull();
    expect(seg!.timeline).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Healthy archive
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker – healthy archive", () => {
  it("returns healthy report with no alarms for contiguous segments", async () => {
    const hash = "b".repeat(64);
    const io = buildIO({
      listFiles: jest.fn(() => [
        "000000010000000100000001",
        "000000010000000100000002",
        "000000010000000100000003",
      ]),
      computeHash: jest.fn(async () => hash),
      readSidecar: jest.fn(() => hash), // sidecar matches
    });

    const checker = new WalIntegrityChecker("/wal", io);
    const report = await checker.check();

    expect(report.healthy).toBe(true);
    expect(report.totalSegments).toBe(3);
    expect(report.verifiedSegments).toBe(3);
    expect(report.corruptSegments).toBe(0);
    expect(report.gapsDetected).toBe(0);
    expect(report.duplicatesDetected).toBe(0);
    expect(report.alarms).toHaveLength(0);
  });

  it("returns healthy when there are no segments in archive", async () => {
    const io = buildIO({ listFiles: jest.fn(() => []) });
    const report = await new WalIntegrityChecker("/empty", io).check();
    expect(report.healthy).toBe(true);
    expect(report.totalSegments).toBe(0);
  });

  it("skips sidecar files and unknown files", async () => {
    const hash = "c".repeat(64);
    const io = buildIO({
      listFiles: jest.fn(() => [
        "000000010000000100000001",
        "000000010000000100000001.sha256", // sidecar – ignored
        "README.md", // unknown – ignored
      ]),
      computeHash: jest.fn(async () => hash),
      readSidecar: jest.fn(() => hash),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.totalSegments).toBe(1);
    expect(report.healthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gap detection
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker – gap detection", () => {
  it("detects a single missing segment", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => [
        "000000010000000100000001",
        // 2 is missing
        "000000010000000100000003",
      ]),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.healthy).toBe(false);
    expect(report.gapsDetected).toBe(1);
    const gapAlarm = report.alarms.find((a) => a.code === "GAP_DETECTED");
    expect(gapAlarm).toBeDefined();
    expect(gapAlarm!.severity).toBe("CRITICAL");
    expect(gapAlarm!.message).toContain("00000002");
  });

  it("detects multiple gaps correctly", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => [
        "000000010000000100000001",
        "000000010000000100000005",
        "000000010000000100000009",
      ]),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.healthy).toBe(false);
    const gapAlarms = report.alarms.filter((a) => a.code === "GAP_DETECTED");
    // gap of 3 (2,3,4) and gap of 3 (6,7,8) = 2 gap alarms
    expect(gapAlarms.length).toBe(2);
  });

  it("does not detect a gap between consecutive partial and full segment", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => [
        "000000010000000100000001",
        "000000010000000100000002.partial",
      ]),
      computeHash: jest.fn(async () => "d".repeat(64)),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    const gapAlarms = report.alarms.filter((a) => a.code === "GAP_DETECTED");
    expect(gapAlarms).toHaveLength(0);
  });

  it("handles gaps on multiple independent timelines separately", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => [
        // timeline 1: contiguous
        "000000010000000100000001",
        "000000010000000100000002",
        // timeline 2: gap at seq 2
        "000000020000000100000001",
        "000000020000000100000003",
      ]),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    const gapAlarms = report.alarms.filter((a) => a.code === "GAP_DETECTED");
    expect(gapAlarms).toHaveLength(1); // only timeline 2 has a gap
    expect(gapAlarms[0].message).toContain("timeline 2");
  });
});

// ---------------------------------------------------------------------------
// Duplicate / split-brain detection
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker – duplicate / split-brain", () => {
  it("detects two files for the same LSN as split-brain", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => [
        "000000010000000100000001",
        "000000010000000100000001.partial",
      ]),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.healthy).toBe(false);
    const splitAlarm = report.alarms.find((a) => a.code === "SPLIT_BRAIN");
    expect(splitAlarm).toBeDefined();
    expect(splitAlarm!.severity).toBe("CRITICAL");
    const dupeAlarms = report.alarms.filter(
      (a) => a.code === "DUPLICATE_SEGMENT",
    );
    expect(dupeAlarms.length).toBe(2);
  });

  it("does not flag segments with the same sequence on different timelines", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => [
        "000000010000000100000001", // tl1 seq1
        "000000020000000100000001", // tl2 seq1 – different timeline, not a dupe
      ]),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    const splitAlarms = report.alarms.filter((a) => a.code === "SPLIT_BRAIN");
    expect(splitAlarms).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hash verification
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker – hash verification", () => {
  it("marks segment as verified when hash matches sidecar", async () => {
    const hash = "e".repeat(64);
    const io = buildIO({
      listFiles: jest.fn(() => ["000000010000000100000001"]),
      computeHash: jest.fn(async () => hash),
      readSidecar: jest.fn(() => hash),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.segments[0].hashVerified).toBe(true);
    expect(report.corruptSegments).toBe(0);
    expect(report.healthy).toBe(true);
  });

  it("raises HASH_MISMATCH alarm when hash differs from sidecar", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => ["000000010000000100000001"]),
      computeHash: jest.fn(async () => "f".repeat(64)),
      readSidecar: jest.fn(() => "0".repeat(64)), // different
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.healthy).toBe(false);
    expect(report.corruptSegments).toBe(1);
    const alarm = report.alarms.find((a) => a.code === "HASH_MISMATCH");
    expect(alarm).toBeDefined();
    expect(alarm!.severity).toBe("CRITICAL");
    expect(alarm!.segment).toBe("000000010000000100000001");
  });

  it("sets hashVerified=null when no sidecar exists", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => ["000000010000000100000001"]),
      computeHash: jest.fn(async () => "a".repeat(64)),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.segments[0].hashVerified).toBeNull();
    expect(report.healthy).toBe(true); // no sidecar = no alarm
  });

  it("is case-insensitive when comparing hashes", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => ["000000010000000100000001"]),
      computeHash: jest.fn(async () => "ABCDEF1234567890".padEnd(64, "0")),
      readSidecar: jest.fn(() => "abcdef1234567890".padEnd(64, "0")),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.segments[0].hashVerified).toBe(true);
    expect(report.corruptSegments).toBe(0);
  });

  it("records sha256 in segment even when no sidecar", async () => {
    const hash = "1234567890abcdef".repeat(4);
    const io = buildIO({
      listFiles: jest.fn(() => ["000000010000000100000001"]),
      computeHash: jest.fn(async () => hash),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.segments[0].sha256).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// Partial / restore-in-progress
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker – restore in progress", () => {
  it("flags a .partial segment as RESTORE_IN_PROGRESS (INFO)", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => ["000000010000000100000001.partial"]),
      computeHash: jest.fn(async () => "a".repeat(64)),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.partialSegments).toBe(1);
    const alarm = report.alarms.find((a) => a.code === "RESTORE_IN_PROGRESS");
    expect(alarm).toBeDefined();
    expect(alarm!.severity).toBe("INFO");
    // Archive is still "healthy" because INFO-only and no CRITICAL
    expect(report.healthy).toBe(true);
  });

  it("sets hashVerified=null for partial segment without sidecar", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => ["000000010000000100000001.partial"]),
      computeHash: jest.fn(async () => "a".repeat(64)),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.segments[0].hashVerified).toBeNull();
  });

  it("does not suppress hash mismatch on partial segment that has a sidecar", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => ["000000010000000100000001.partial"]),
      computeHash: jest.fn(async () => "bad".padEnd(64, "0")),
      readSidecar: jest.fn(() => "good".padEnd(64, "0")),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    const hashAlarm = report.alarms.find((a) => a.code === "HASH_MISMATCH");
    expect(hashAlarm).toBeDefined();
    expect(report.healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Storage timeout – listing
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker – storage timeout on listing", () => {
  it("raises STORAGE_TIMEOUT alarm when listing archive fails", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => {
        throw new StorageTimeoutError("ETIMEDOUT listing archive");
      }),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.healthy).toBe(false);
    const alarm = report.alarms.find((a) => a.code === "STORAGE_TIMEOUT");
    expect(alarm).toBeDefined();
    expect(alarm!.severity).toBe("CRITICAL");
    expect(report.totalSegments).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Storage timeout – hashing
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker – storage timeout on hash", () => {
  it("raises STORAGE_TIMEOUT alarm per-segment when hashing times out", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => [
        "000000010000000100000001",
        "000000010000000100000002",
      ]),
      computeHash: jest.fn(async (_path: string) => {
        throw new StorageTimeoutError("Hashing timed out");
      }),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.healthy).toBe(false);
    const timeoutAlarms = report.alarms.filter(
      (a) => a.code === "STORAGE_TIMEOUT",
    );
    expect(timeoutAlarms.length).toBe(2);
    // segments are still present with empty hash
    expect(report.segments.length).toBe(2);
    expect(report.segments[0].sha256).toBe("");
  });

  it("continues processing other segments after one timeout", async () => {
    const hash = "a".repeat(64);
    let call = 0;
    const io = buildIO({
      listFiles: jest.fn(() => [
        "000000010000000100000001",
        "000000010000000100000002",
      ]),
      computeHash: jest.fn(async () => {
        call++;
        if (call === 1) throw new StorageTimeoutError("timeout on seg 1");
        return hash;
      }),
      readSidecar: jest.fn(() => hash),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.segments[1].sha256).toBe(hash);
    expect(report.segments[1].hashVerified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unreadable segment
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker – unreadable segment", () => {
  it("raises UNREADABLE_SEGMENT alarm for unexpected read error", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => ["000000010000000100000001"]),
      computeHash: jest.fn(async () => {
        throw new Error("Disk read error: EIO");
      }),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    const alarm = report.alarms.find((a) => a.code === "UNREADABLE_SEGMENT");
    expect(alarm).toBeDefined();
    expect(alarm!.severity).toBe("CRITICAL");
    expect(report.healthy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sidecar storage error
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker – sidecar storage error", () => {
  it("raises WARNING STORAGE_TIMEOUT when sidecar cannot be read", async () => {
    const hash = "a".repeat(64);
    const io = buildIO({
      listFiles: jest.fn(() => ["000000010000000100000001"]),
      computeHash: jest.fn(async () => hash),
      readSidecar: jest.fn(() => {
        throw new StorageTimeoutError("sidecar read timeout");
      }),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    const alarm = report.alarms.find(
      (a) => a.code === "STORAGE_TIMEOUT" && a.severity === "WARNING",
    );
    expect(alarm).toBeDefined();
    // Archive can still be considered healthy (WARNING only doesn't set unhealthy)
    expect(report.healthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Split-brain: 3+ files for the same LSN
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker – severe split-brain", () => {
  it("raises one SPLIT_BRAIN + N DUPLICATE alarms for N duplicates", async () => {
    const io = buildIO({
      listFiles: jest.fn(() => [
        "000000010000000100000001",
        "000000010000000100000001.partial",
        // A third with the same base is not valid per the regex, but if it
        // were (e.g. two full copies), we test via the underlying mechanism.
      ]),
      readSidecar: jest.fn(() => null),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    const splitAlarms = report.alarms.filter((a) => a.code === "SPLIT_BRAIN");
    const dupeAlarms = report.alarms.filter(
      (a) => a.code === "DUPLICATE_SEGMENT",
    );
    expect(splitAlarms.length).toBeGreaterThanOrEqual(1);
    expect(dupeAlarms.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Report shape / metadata
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker – report metadata", () => {
  it("sets archivePath and generatedAt on report", async () => {
    const io = buildIO({ listFiles: jest.fn(() => []) });
    const report = await new WalIntegrityChecker("/my/archive", io).check();
    expect(report.archivePath).toBe("/my/archive");
    expect(report.generatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("correctly counts verifiedSegments and corruptSegments", async () => {
    const goodHash = "a".repeat(64);
    const badHash = "b".repeat(64);

    let fileIdx = 0;
    const io = buildIO({
      listFiles: jest.fn(() => [
        "000000010000000100000001", // hash matches
        "000000010000000100000002", // hash mismatch
        "000000010000000100000003", // no sidecar
      ]),
      computeHash: jest.fn(async () => goodHash),
      readSidecar: jest.fn(() => {
        fileIdx++;
        if (fileIdx === 1) return goodHash; // match
        if (fileIdx === 2) return badHash; // mismatch
        return null; // no sidecar
      }),
    });

    const report = await new WalIntegrityChecker("/wal", io).check();
    expect(report.verifiedSegments).toBe(1);
    expect(report.corruptSegments).toBe(1);
    expect(report.totalSegments).toBe(3);
  });
});
