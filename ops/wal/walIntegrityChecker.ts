/**
 * WAL Archive Integrity Checker
 *
 * Walks a WAL (Write-Ahead Log) archive directory, hash-verifies every segment,
 * detects gaps and duplicates in the segment sequence, and surfaces alarms for
 * any issue found.
 *
 * Design assumptions / security notes:
 *  - Segment filenames follow the PostgreSQL-style naming convention:
 *      <timeline><segment_hex_8> e.g. 0000000100000001, or with a .partial suffix
 *      for segments still being written.
 *  - Each segment may ship with a sidecar <filename>.sha256 file that records the
 *    expected digest. When the sidecar is absent the segment is still hash-computed
 *    and stored in the report, but no corruption alarm is raised (the hash is
 *    unknowable until a reference exists).
 *  - A segment with suffix .partial is flagged as "restore in progress" – its
 *    hash is computed and reported but the missing-sidecar alarm is suppressed.
 *  - Storage timeouts (ETIMEDOUT / ECONNRESET / slow reads) are caught and surfaced
 *    as STORAGE_TIMEOUT alarms rather than uncaught exceptions.
 *  - Split-brain detection: if more than one segment file maps to the same LSN
 *    position (same sequence number regardless of extension/suffix) an alarm is
 *    raised.
 */

import { createHash } from "crypto";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AlarmSeverity = "CRITICAL" | "WARNING" | "INFO";

export interface WalAlarm {
  severity: AlarmSeverity;
  code: WalAlarmCode;
  message: string;
  segment?: string;
}

export type WalAlarmCode =
  | "HASH_MISMATCH"
  | "GAP_DETECTED"
  | "DUPLICATE_SEGMENT"
  | "STORAGE_TIMEOUT"
  | "UNREADABLE_SEGMENT"
  | "SPLIT_BRAIN"
  | "RESTORE_IN_PROGRESS";

export interface WalSegmentResult {
  filename: string;
  sequenceNumber: number;
  timeline: number;
  sizeBytes: number;
  sha256: string;
  isPartial: boolean;
  hashVerified: boolean | null; // null when no sidecar exists
  alarms: WalAlarm[];
}

export interface WalIntegrityReport {
  archivePath: string;
  generatedAt: string; // ISO-8601
  totalSegments: number;
  verifiedSegments: number;
  corruptSegments: number;
  gapsDetected: number;
  duplicatesDetected: number;
  partialSegments: number;
  alarms: WalAlarm[];
  segments: WalSegmentResult[];
  healthy: boolean;
}

// ---------------------------------------------------------------------------
// Configuration / injectable I/O interface (for testability)
// ---------------------------------------------------------------------------

export interface WalCheckerIO {
  /**
   * List filenames in the archive directory (not recursively).
   * Throws StorageTimeoutError on I/O failure.
   */
  listFiles(dir: string): string[];

  /**
   * Compute the SHA-256 hex digest of a file.
   * Throws StorageTimeoutError on I/O failure.
   */
  computeHash(filePath: string): Promise<string>;

  /**
   * Read the expected hash from a sidecar file.
   * Returns null if the sidecar does not exist.
   * Throws StorageTimeoutError on I/O failure.
   */
  readSidecar(filePath: string): string | null;

  /**
   * Return the byte-size of a file.
   */
  fileSize(filePath: string): number;
}

// ---------------------------------------------------------------------------
// Storage timeout sentinel
// ---------------------------------------------------------------------------

export class StorageTimeoutError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StorageTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Default real filesystem I/O implementation
// ---------------------------------------------------------------------------

const HASH_TIMEOUT_MS = parseInt(
  process.env.WAL_HASH_TIMEOUT_MS ?? "30000",
  10,
);

const STORAGE_TIMEOUT_SIGNALS = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOENT",
  "EACCES",
  "EIO",
]);

function looksLikeStorageError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    return STORAGE_TIMEOUT_SIGNALS.has(code);
  }
  return false;
}

/** @internal – exported for testing only */
export { looksLikeStorageError };

/**
 * Hash a file via streaming with a configurable timeout.
 */
export function hashFileWithTimeout(
  filePath: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    timer = setTimeout(() => {
      stream.destroy();
      reject(
        new StorageTimeoutError(
          `Hashing ${filePath} timed out after ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => {
      cleanup();
      resolve(hash.digest("hex"));
    });
    stream.on("error", (err) => {
      cleanup();
      if (looksLikeStorageError(err)) {
        reject(
          new StorageTimeoutError(`Storage error reading ${filePath}`, err),
        );
      } else {
        reject(err);
      }
    });
  });
}

export const defaultIO: WalCheckerIO = {
  listFiles(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch (err) {
      if (looksLikeStorageError(err)) {
        throw new StorageTimeoutError(`Failed to list archive at ${dir}`, err);
      }
      throw err;
    }
  },

  async computeHash(filePath: string): Promise<string> {
    return hashFileWithTimeout(filePath, HASH_TIMEOUT_MS);
  },

  readSidecar(filePath: string): string | null {
    if (!existsSync(filePath)) return null;
    try {
      return readFileSync(filePath, "utf8").trim();
    } catch (err) {
      if (looksLikeStorageError(err)) {
        throw new StorageTimeoutError(
          `Storage error reading sidecar ${filePath}`,
          err,
        );
      }
      throw err;
    }
  },

  fileSize(filePath: string): number {
    try {
      return statSync(filePath).size;
    } catch {
      return 0;
    }
  },
};

// ---------------------------------------------------------------------------
// Segment parsing
// ---------------------------------------------------------------------------

/**
 * PostgreSQL WAL segment naming:
 *   <tl_hex_8><seg_hex_8>[.partial]
 * e.g. 000000010000000100000001
 *      000000010000000100000002.partial
 *
 * We also tolerate an optional .sha256 sidecar (which we skip as a "segment").
 */
const SEGMENT_RE =
  /^([0-9A-Fa-f]{8})([0-9A-Fa-f]{8}(?:[0-9A-Fa-f]{8})?)(?:\.partial)?$/;

export interface ParsedSegment {
  filename: string;
  timeline: number;
  sequenceNumber: number;
  isPartial: boolean;
}

export function parseSegmentFilename(
  filename: string,
): ParsedSegment | null {
  // strip .partial suffix before matching
  const isPartial = filename.endsWith(".partial");
  const base = isPartial ? filename.slice(0, -8) : filename;

  const match = SEGMENT_RE.exec(base);
  if (!match) return null;

  const timeline = parseInt(match[1], 16);
  const sequenceNumber = parseInt(match[2], 16);

  return { filename, timeline, sequenceNumber, isPartial };
}

// ---------------------------------------------------------------------------
// Core checker
// ---------------------------------------------------------------------------

export class WalIntegrityChecker {
  private readonly archivePath: string;
  private readonly io: WalCheckerIO;

  constructor(archivePath: string, io: WalCheckerIO = defaultIO) {
    this.archivePath = archivePath;
    this.io = io;
  }

  /**
   * Run a full integrity check and return the report.
   * Never throws – all I/O errors are captured as alarms.
   */
  async check(): Promise<WalIntegrityReport> {
    const alarms: WalAlarm[] = [];
    const segments: WalSegmentResult[] = [];

    // Step 1 – list the archive
    let filenames: string[] = [];
    try {
      filenames = this.io.listFiles(this.archivePath);
    } catch (err) {
      alarms.push({
        severity: "CRITICAL",
        code: "STORAGE_TIMEOUT",
        message:
          err instanceof Error
            ? err.message
            : `Failed to list archive: ${String(err)}`,
      });
      return this.buildReport(alarms, segments);
    }

    // Step 2 – parse segment filenames (skip sidecars and unknowns)
    const parsed: ParsedSegment[] = [];
    for (const filename of filenames) {
      // skip sidecar files
      if (filename.endsWith(".sha256")) continue;
      const seg = parseSegmentFilename(filename);
      if (seg !== null) {
        parsed.push(seg);
      }
      // Unknown / non-matching files are silently ignored – operators may place
      // README files or other metadata in the archive.
    }

    // Step 3 – detect duplicates (split-brain: same sequence number, same timeline)
    const seenKey = new Map<string, string[]>(); // "tl:seq" -> filenames[]
    for (const seg of parsed) {
      const key = `${seg.timeline}:${seg.sequenceNumber}`;
      const existing = seenKey.get(key) ?? [];
      existing.push(seg.filename);
      seenKey.set(key, existing);
    }

    for (const [key, names] of seenKey.entries()) {
      if (names.length > 1) {
        // Multiple files map to the same LSN position – split-brain
        alarms.push({
          severity: "CRITICAL",
          code: "SPLIT_BRAIN",
          message: `Split-brain detected: multiple files for LSN position ${key}: ${names.join(", ")}`,
        });
        // Also flag each as DUPLICATE
        for (const name of names) {
          alarms.push({
            severity: "CRITICAL",
            code: "DUPLICATE_SEGMENT",
            message: `Duplicate segment at LSN ${key}`,
            segment: name,
          });
        }
      }
    }

    // Step 4 – per-timeline sort and gap detection
    const byTimeline = new Map<number, ParsedSegment[]>();
    for (const seg of parsed) {
      const tl = seg.timeline;
      const existing = byTimeline.get(tl) ?? [];
      existing.push(seg);
      byTimeline.set(tl, existing);
    }

    let gapsDetected = 0;
    for (const [tl, segs] of byTimeline.entries()) {
      const sorted = segs
        .slice()
        .sort((a, b) => a.sequenceNumber - b.sequenceNumber);

      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        const expected = prev.sequenceNumber + 1;

        // If the previous was partial and the next is not exactly prev+1,
        // a restore-in-progress situation exists – suppress full GAP alarm.
        if (curr.sequenceNumber !== expected) {
          const gapSize = curr.sequenceNumber - expected;
          _gapsDetected += gapSize;
          alarms.push({
            severity: "CRITICAL",
            code: "GAP_DETECTED",
            message:
              `Gap in timeline ${tl}: segment ${expected.toString(16).padStart(8, "0")} ` +
              `through ${(curr.sequenceNumber - 1).toString(16).padStart(8, "0")} missing ` +
              `(${gapSize} segment${gapSize === 1 ? "" : "s"})`,
          });
        }
      }
    }

    // Step 5 – hash each segment
    for (const seg of parsed) {
      const filePath = join(this.archivePath, seg.filename);
      const sidecarPath = filePath + ".sha256";
      const segmentAlarms: WalAlarm[] = [];

      let sha256 = "";
      let sizeBytes = 0;
      let hashVerified: boolean | null = null;

      // Size
      try {
        sizeBytes = this.io.fileSize(filePath);
      } catch {
        sizeBytes = 0;
      }

      // Hash
      try {
        sha256 = await this.io.computeHash(filePath);
      } catch (err) {
        if (err instanceof StorageTimeoutError) {
          const alarm: WalAlarm = {
            severity: "CRITICAL",
            code: "STORAGE_TIMEOUT",
            message: err.message,
            segment: seg.filename,
          };
          segmentAlarms.push(alarm);
          alarms.push(alarm);
        } else {
          const alarm: WalAlarm = {
            severity: "CRITICAL",
            code: "UNREADABLE_SEGMENT",
            message: `Cannot read segment ${seg.filename}: ${err instanceof Error ? err.message : String(err)}`,
            segment: seg.filename,
          };
          segmentAlarms.push(alarm);
          alarms.push(alarm);
        }
        segments.push({
          filename: seg.filename,
          sequenceNumber: seg.sequenceNumber,
          timeline: seg.timeline,
          sizeBytes,
          sha256: "",
          isPartial: seg.isPartial,
          hashVerified: null,
          alarms: segmentAlarms,
        });
        continue;
      }

      // Verify against sidecar
      let expectedHash: string | null = null;
      try {
        expectedHash = this.io.readSidecar(sidecarPath);
      } catch (err) {
        if (err instanceof StorageTimeoutError) {
          const alarm: WalAlarm = {
            severity: "WARNING",
            code: "STORAGE_TIMEOUT",
            message: `Could not read sidecar for ${seg.filename}: ${err.message}`,
            segment: seg.filename,
          };
          segmentAlarms.push(alarm);
          alarms.push(alarm);
        }
        // non-storage error reading sidecar: treat as absent
      }

      if (expectedHash !== null) {
        // Normalise
        const normExpected = expectedHash.trim().toLowerCase();
        const normActual = sha256.trim().toLowerCase();
        hashVerified = normActual === normExpected;
        if (!hashVerified) {
          const alarm: WalAlarm = {
            severity: "CRITICAL",
            code: "HASH_MISMATCH",
            message:
              `Hash mismatch for ${seg.filename}: ` +
              `expected ${normExpected}, got ${normActual}`,
            segment: seg.filename,
          };
          segmentAlarms.push(alarm);
          alarms.push(alarm);
        }
      } else if (seg.isPartial) {
        // Partial segment – announce restore-in-progress (informational only)
        const alarm: WalAlarm = {
          severity: "INFO",
          code: "RESTORE_IN_PROGRESS",
          message: `Segment ${seg.filename} is partial (restore or archiving in progress)`,
          segment: seg.filename,
        };
        segmentAlarms.push(alarm);
        alarms.push(alarm);
        hashVerified = null;
      } else {
        // No sidecar – hash not verifiable
        hashVerified = null;
      }

      segments.push({
        filename: seg.filename,
        sequenceNumber: seg.sequenceNumber,
        timeline: seg.timeline,
        sizeBytes,
        sha256,
        isPartial: seg.isPartial,
        hashVerified,
        alarms: segmentAlarms,
      });
    }

    return this.buildReport(alarms, segments);
  }

  private buildReport(
    alarms: WalAlarm[],
    segments: WalSegmentResult[],
  ): WalIntegrityReport {
    const corruptSegments = segments.filter(
      (s) => s.hashVerified === false,
    ).length;
    const partialSegments = segments.filter((s) => s.isPartial).length;
    const verifiedSegments = segments.filter(
      (s) => s.hashVerified === true,
    ).length;
    const gapsDetected = alarms.filter(
      (a) => a.code === "GAP_DETECTED",
    ).length;
    const duplicatesDetected = alarms.filter(
      (a) => a.code === "DUPLICATE_SEGMENT",
    ).length;

    const healthy =
      alarms.filter(
        (a) =>
          a.severity === "CRITICAL" &&
          a.code !== "RESTORE_IN_PROGRESS",
      ).length === 0;

    return {
      archivePath: this.archivePath,
      generatedAt: new Date().toISOString(),
      totalSegments: segments.length,
      verifiedSegments,
      corruptSegments,
      gapsDetected,
      duplicatesDetected,
      partialSegments,
      alarms,
      segments,
      healthy,
    };
  }
}
