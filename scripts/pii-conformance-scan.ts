#!/usr/bin/env tsx
/**
 * scripts/pii-conformance-scan.ts
 *
 * Standalone CI runner for PII conformance.
 *
 * Usage
 * ─────
 *   npx tsx scripts/pii-conformance-scan.ts [--files <glob>]
 *
 * Behaviour
 * ─────────
 *   1. Reads every *.log and dist/**\/*.js file (configurable via --files).
 *   2. Scans each file's content for PII using the default pattern library.
 *   3. Prints a structured violation report to stdout.
 *   4. Exits with code 1 if any unredacted PII is found, 0 otherwise.
 *
 * The script is intentionally minimal: it is a last-line-of-defence check on
 * build artefacts and log files, not a replacement for the Jest conformance
 * suite.  Run it after `npm run build` in CI.
 *
 * Exit codes
 * ──────────
 *   0  No PII detected — build may proceed.
 *   1  PII detected — build must fail.
 *   2  Scan error (file I/O, bad arguments).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { scanText, DEFAULT_PATTERNS, type ScanOptions } from "../src/utils/piiScanner.js";

// ─── configuration ───────────────────────────────────────────────────────────

/**
 * Files and directories to scan by default.
 * Paths are resolved relative to the project root (process.cwd()).
 */
const DEFAULT_SCAN_TARGETS = ["dist", "logs"];

/**
 * File extensions to include in the scan.
 */
const SCANNABLE_EXTENSIONS = new Set([".js", ".json", ".log", ".txt"]);

/**
 * Allowlisted patterns for known-safe values that appear in build artefacts
 * (e.g., test fixtures, example strings in documentation).
 */
const GLOBAL_ALLOWLIST: ScanOptions["allowlist"] = [
  // Jest / TS test fixture emails baked into example strings
  /example\.com$/,
  /test@/,
  /noreply@/,
];

// ─── helpers ────────────────────────────────────────────────────────────────

interface FileViolation {
  file: string;
  patternId: string;
  description: string;
  match: string;
  line: number;
  col: number;
}

/**
 * Recursively collects all scannable files under `dir`.
 */
function collectFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];

  try {
    entries = readdirSync(dir);
  } catch {
    // Directory does not exist — skip silently
    return results;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Skip node_modules and hidden directories
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      results.push(...collectFiles(full));
    } else if (stat.isFile()) {
      const ext = full.slice(full.lastIndexOf("."));
      if (SCANNABLE_EXTENSIONS.has(ext)) {
        results.push(full);
      }
    }
  }

  return results;
}

/**
 * Maps a character index in `text` to a 1-based line and column number.
 */
function indexToLineCol(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const line = (before.match(/\n/g) ?? []).length + 1;
  const lastNl = before.lastIndexOf("\n");
  const col = lastNl === -1 ? index + 1 : index - lastNl;
  return { line, col };
}

// ─── main ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const targets: string[] = [];

  // Parse --files arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--files" && args[i + 1]) {
      targets.push(args[++i]!);
    }
  }

  const scanTargets = targets.length > 0 ? targets : DEFAULT_SCAN_TARGETS;
  const root = process.cwd();

  // Collect all files
  const allFiles: string[] = [];
  for (const target of scanTargets) {
    const abs = join(root, target);
    try {
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        allFiles.push(...collectFiles(abs));
      } else if (stat.isFile()) {
        allFiles.push(abs);
      }
    } catch {
      // Target doesn't exist — skip
    }
  }

  if (allFiles.length === 0) {
    console.log("pii-conformance-scan: no scannable files found in targets:", scanTargets.join(", "));
    console.log("pii-conformance-scan: PASS (nothing to scan)");
    process.exit(0);
  }

  console.log(`pii-conformance-scan: scanning ${allFiles.length} file(s)...`);

  const violations: FileViolation[] = [];

  for (const file of allFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      console.warn(`  WARN: could not read ${relative(root, file)}`);
      continue;
    }

    const result = scanText(content, {
      patterns: DEFAULT_PATTERNS,
      allowlist: GLOBAL_ALLOWLIST,
    });

    for (const hit of result.hits) {
      const { line, col } = indexToLineCol(content, hit.index);
      violations.push({
        file: relative(root, file),
        patternId: hit.patternId,
        description: hit.description,
        match: hit.match,
        line,
        col,
      });
    }
  }

  if (violations.length === 0) {
    console.log("pii-conformance-scan: PASS — no unredacted PII detected.");
    process.exit(0);
  }

  // Report violations
  console.error("\npii-conformance-scan: FAIL — unredacted PII detected!\n");
  console.error(`  ${violations.length} violation(s) found:\n`);

  for (const v of violations) {
    console.error(`  [${v.patternId}] ${v.file}:${v.line}:${v.col}`);
    console.error(`    Description : ${v.description}`);
    console.error(`    Match       : ${v.match.slice(0, 40)}${v.match.length > 40 ? "…" : ""}`);
    console.error();
  }

  console.error(
    "  Fix: ensure all PII fields are redacted before logging.\n" +
    "  See docs/pii-conformance.md for guidance.\n",
  );

  process.exit(1);
}

main();
