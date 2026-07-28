/**
 * Tests for the real filesystem I/O layer (defaultIO), internal helpers,
 * and uncovered CLI branches.
 *
 * These tests use real temp files so they exercise the actual fs code paths
 * that the mock-IO tests cannot reach.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  defaultIO,
  hashFileWithTimeout,
  looksLikeStorageError,
  StorageTimeoutError,
} from "../walIntegrityChecker";
import { main } from "../../../scripts/check-wal-integrity";

// ---------------------------------------------------------------------------
// looksLikeStorageError
// ---------------------------------------------------------------------------

describe("looksLikeStorageError", () => {
  it("returns true for ETIMEDOUT", () => {
    const err = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    expect(looksLikeStorageError(err)).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(looksLikeStorageError(err)).toBe(true);
  });

  it("returns true for ENOENT", () => {
    const err = Object.assign(new Error("not found"), { code: "ENOENT" });
    expect(looksLikeStorageError(err)).toBe(true);
  });

  it("returns true for EACCES", () => {
    const err = Object.assign(new Error("permission"), { code: "EACCES" });
    expect(looksLikeStorageError(err)).toBe(true);
  });

  it("returns true for EIO", () => {
    const err = Object.assign(new Error("io error"), { code: "EIO" });
    expect(looksLikeStorageError(err)).toBe(true);
  });

  it("returns false for a non-storage error code", () => {
    const err = Object.assign(new Error("unexpected"), { code: "ERANGE" });
    expect(looksLikeStorageError(err)).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(looksLikeStorageError("string error")).toBe(false);
    expect(looksLikeStorageError(42)).toBe(false);
    expect(looksLikeStorageError(null)).toBe(false);
    expect(looksLikeStorageError(undefined)).toBe(false);
  });

  it("returns false when err.code is undefined", () => {
    expect(looksLikeStorageError(new Error("no code"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hashFileWithTimeout
// ---------------------------------------------------------------------------

describe("hashFileWithTimeout", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("computes SHA-256 of a real file", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-test-"));
    const filePath = join(tmpDir, "segment");
    writeFileSync(filePath, "hello world");

    const hash = await hashFileWithTimeout(filePath, 5000);
    // just assert it's a valid 64-char hex digest
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves consistently (same content → same hash)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-test-"));
    const filePath = join(tmpDir, "segment");
    writeFileSync(filePath, Buffer.alloc(1024, 0xab));

    const h1 = await hashFileWithTimeout(filePath, 5000);
    const h2 = await hashFileWithTimeout(filePath, 5000);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects on non-existent file (ENOENT)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-test-"));
    const filePath = join(tmpDir, "nonexistent");
    await expect(hashFileWithTimeout(filePath, 5000)).rejects.toThrow();
  });

  it("rejects with StorageTimeoutError on simulated timeout (very short timeout)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-test-"));
    const filePath = join(tmpDir, "large");
    // Write 1 MB so streaming takes some time
    writeFileSync(filePath, Buffer.alloc(1024 * 1024, 0xff));

    // 0 ms timeout fires before first chunk
    await expect(hashFileWithTimeout(filePath, 0)).rejects.toThrow(
      /timed out/,
    );
  });
});

// ---------------------------------------------------------------------------
// defaultIO.listFiles
// ---------------------------------------------------------------------------

describe("defaultIO.listFiles", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists files in a real directory", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-list-"));
    writeFileSync(join(tmpDir, "000000010000000100000001"), "");
    writeFileSync(join(tmpDir, "000000010000000100000002"), "");

    const files = defaultIO.listFiles(tmpDir);
    expect(files).toContain("000000010000000100000001");
    expect(files).toContain("000000010000000100000002");
  });

  it("throws on non-existent directory", () => {
    expect(() => defaultIO.listFiles("/nonexistent/path/wal")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// defaultIO.readSidecar
// ---------------------------------------------------------------------------

describe("defaultIO.readSidecar", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when sidecar does not exist", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-side-"));
    const result = defaultIO.readSidecar(join(tmpDir, "nothere.sha256"));
    expect(result).toBeNull();
  });

  it("reads and trims content from sidecar", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-side-"));
    const sidecarPath = join(tmpDir, "seg.sha256");
    writeFileSync(sidecarPath, "  abcdef1234  \n");
    expect(defaultIO.readSidecar(sidecarPath)).toBe("abcdef1234");
  });
});

// ---------------------------------------------------------------------------
// defaultIO.computeHash
// ---------------------------------------------------------------------------

describe("defaultIO.computeHash", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a 64-char hex digest for a real file", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-hash-"));
    const filePath = join(tmpDir, "segment");
    writeFileSync(filePath, "wal segment content");

    const hash = await defaultIO.computeHash(filePath);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// defaultIO.fileSize
// ---------------------------------------------------------------------------

describe("defaultIO.fileSize", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns file size in bytes", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-size-"));
    const filePath = join(tmpDir, "segment");
    writeFileSync(filePath, Buffer.alloc(512));
    expect(defaultIO.fileSize(filePath)).toBe(512);
  });

  it("returns 0 for non-existent file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-size-"));
    expect(defaultIO.fileSize(join(tmpDir, "missing"))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full real-filesystem integration: WalIntegrityChecker with defaultIO
// ---------------------------------------------------------------------------

describe("WalIntegrityChecker (real fs)", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("verifies a real archive with matching sidecar hashes", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-archive-"));
    const seg = "000000010000000100000001";
    const content = Buffer.alloc(256, 0x42);
    writeFileSync(join(tmpDir, seg), content);

    // compute hash manually using Node crypto to write matching sidecar
    const { createHash } = await import("crypto");
    const expectedHash = createHash("sha256").update(content).digest("hex");
    writeFileSync(join(tmpDir, seg + ".sha256"), expectedHash);

    const { WalIntegrityChecker } = await import("../walIntegrityChecker");
    const checker = new WalIntegrityChecker(tmpDir);
    const report = await checker.check();

    expect(report.healthy).toBe(true);
    expect(report.totalSegments).toBe(1);
    expect(report.verifiedSegments).toBe(1);
    expect(report.segments[0].hashVerified).toBe(true);
  });

  it("raises HASH_MISMATCH on a corrupted segment", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wal-archive-"));
    const seg = "000000010000000100000001";
    writeFileSync(join(tmpDir, seg), Buffer.alloc(256, 0x42));
    // wrong sidecar
    writeFileSync(join(tmpDir, seg + ".sha256"), "0".repeat(64));

    const { WalIntegrityChecker } = await import("../walIntegrityChecker");
    const report = await new WalIntegrityChecker(tmpDir).check();

    expect(report.healthy).toBe(false);
    expect(report.corruptSegments).toBe(1);
    const alarm = report.alarms.find((a) => a.code === "HASH_MISMATCH");
    expect(alarm).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CLI – uncovered branches (invalid format / severity, process.exit guard)
// ---------------------------------------------------------------------------

describe("CLI – uncovered branches", () => {
  it("exits 1 for unknown --format and calls process.exit", async () => {
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((_code?: number) => {
        throw new Error(`process.exit(${_code})`);
      });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      main(["--archive", "/wal", "--format", "yaml"]),
    ).rejects.toThrow("process.exit(1)");

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("exits 1 for unknown --min-severity and calls process.exit", async () => {
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((_code?: number) => {
        throw new Error(`process.exit(${_code})`);
      });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      main(["--archive", "/wal", "--min-severity", "VERBOSE"]),
    ).rejects.toThrow("process.exit(1)");

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
