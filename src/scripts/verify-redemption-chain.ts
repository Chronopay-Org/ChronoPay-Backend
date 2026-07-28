#!/usr/bin/env tsx
/**
 * verify-redemption-chain.ts
 *
 * CLI utility that walks the redemption ledger hash-chain and reports whether
 * the chain is intact.  Exits with code 0 on success, 1 on failure.
 *
 * ## Usage
 *
 * ```bash
 * # Against the default DATABASE_URL
 * npx tsx src/scripts/verify-redemption-chain.ts
 *
 * # With a custom connection string
 * DATABASE_URL=postgres://... npx tsx src/scripts/verify-redemption-chain.ts
 *
 * # Verbose output (print every entry)
 * npx tsx src/scripts/verify-redemption-chain.ts --verbose
 * ```
 *
 * ## Exit codes
 *
 * | Code | Meaning                                      |
 * |------|----------------------------------------------|
 * |    0 | Chain is intact (or ledger is empty)         |
 * |    1 | Chain violation found or fatal error         |
 *
 * ## Algorithm
 *
 * 1. Fetch all rows from `redemption_ledger` ordered by `created_at ASC`.
 * 2. For each row, re-derive `SHA-256(redemption_id|prev_hash|created_at_iso)`.
 * 3. Compare with the stored `entry_hash`.
 * 4. For every non-genesis row, verify `prev_hash == entry_hash of predecessor`.
 * 5. Report the first violation found, or "OK" if the chain is intact.
 *
 * When no real database is available (e.g. during a dry-run) the script can
 * be pointed at the in-memory ledger by importing and invoking `runVerifier`
 * programmatically.
 */

import { createHash } from "crypto";

// ─── Minimal types (mirrors redemptionLedger.ts without importing from it) ───

interface LedgerRow {
  redemption_id: string;
  entry_hash: string;
  prev_hash: string;
  created_at: Date | string;
}

// ─── Hash derivation (kept local to avoid runtime dep on the service) ─────────

function deriveHash(
  redemptionId: string,
  prevHash: string,
  createdAt: Date | string,
): string {
  const iso =
    createdAt instanceof Date ? createdAt.toISOString() : createdAt;
  return createHash("sha256")
    .update(`${redemptionId}|${prevHash}|${iso}`, "utf8")
    .digest("hex");
}

// ─── Verifier logic ───────────────────────────────────────────────────────────

export interface VerifierReport {
  valid: boolean;
  entriesChecked: number;
  firstBrokenIndex?: number;
  error?: string;
}

/**
 * Walk an array of ledger rows and verify the hash-chain.
 * Rows must already be in `created_at ASC` order.
 *
 * This function is exported for programmatic use (e.g. in integration tests)
 * without starting a database connection.
 */
export function walkChain(rows: LedgerRow[]): VerifierReport {
  if (rows.length === 0) {
    return { valid: true, entriesChecked: 0 };
  }

  const genesis = rows[0];
  if (genesis.prev_hash !== "") {
    return {
      valid: false,
      entriesChecked: 1,
      firstBrokenIndex: 0,
      error: `Genesis entry has non-empty prev_hash: "${genesis.prev_hash}"`,
    };
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const expected = deriveHash(row.redemption_id, row.prev_hash, row.created_at);

    if (row.entry_hash !== expected) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstBrokenIndex: i,
        error:
          `Row ${i} (redemption_id=${row.redemption_id}): ` +
          `entry_hash mismatch. Expected ${expected}, stored ${row.entry_hash}`,
      };
    }

    if (i > 0 && row.prev_hash !== rows[i - 1].entry_hash) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstBrokenIndex: i,
        error:
          `Row ${i} (redemption_id=${row.redemption_id}): ` +
          `prev_hash "${row.prev_hash}" does not match ` +
          `predecessor hash "${rows[i - 1].entry_hash}"`,
      };
    }
  }

  return { valid: true, entriesChecked: rows.length };
}

// ─── Database fetch (Postgres) ────────────────────────────────────────────────

/**
 * Fetch all ledger rows from Postgres in ascending `created_at` order.
 * Returns them as plain objects so `walkChain` can be used without a db dep.
 */
async function fetchRowsFromDb(): Promise<LedgerRow[]> {
  // Dynamically import pg so the script file compiles even when pg is absent
  // in environments that only run unit tests.
  const { Pool } = await import("pg");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. " +
        "Export it before running this script, e.g.:\n" +
        "  DATABASE_URL=postgres://user:pass@localhost/db tsx src/scripts/verify-redemption-chain.ts",
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const { rows } = await pool.query<{
      redemption_id: string;
      entry_hash: string;
      prev_hash: string | null;
      created_at: Date;
    }>(
      `SELECT redemption_id, entry_hash, prev_hash, created_at
         FROM redemption_ledger
        ORDER BY created_at ASC`,
    );

    return rows.map((r) => ({
      redemption_id: r.redemption_id,
      entry_hash: r.entry_hash,
      // NULL in the DB == "" in the hash derivation (genesis row)
      prev_hash: r.prev_hash ?? "",
      created_at: r.created_at,
    }));
  } finally {
    await pool.end();
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run the verifier and write a human-readable report to stdout.
 *
 * @param rows     Pre-fetched rows (used when running programmatically /
 *                 in tests).  When omitted, rows are fetched from Postgres.
 * @param verbose  Print every checked entry.
 */
export async function runVerifier(
  rows?: LedgerRow[],
  verbose = false,
): Promise<VerifierReport> {
  const data = rows ?? (await fetchRowsFromDb());

  if (verbose) {
    console.log(
      `Verifying ${data.length} redemption ledger entr${data.length === 1 ? "y" : "ies"}…`,
    );
    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      const iso =
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : r.created_at;
      console.log(
        `  [${i}] redemption_id=${r.redemption_id} ` +
          `hash=${r.entry_hash.substring(0, 16)}… ` +
          `prev=${r.prev_hash ? r.prev_hash.substring(0, 16) + "…" : "(genesis)"} ` +
          `created_at=${iso}`,
      );
    }
  }

  const report = walkChain(data);

  if (report.valid) {
    console.log(
      `✓ Redemption ledger chain is intact (${report.entriesChecked} entr${report.entriesChecked === 1 ? "y" : "ies"} checked).`,
    );
  } else {
    console.error(`✗ Chain integrity violation detected!`);
    console.error(`  ${report.error}`);
    console.error(
      `  First broken entry index: ${report.firstBrokenIndex} ` +
        `(out of ${report.entriesChecked} entries checked)`,
    );
  }

  return report;
}

// ─── CLI bootstrap ────────────────────────────────────────────────────────────

// Only execute when run directly (not when imported by tests).
// Detection: if the module is the main entry point in Node.js ESM.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("verify-redemption-chain.ts") ||
    process.argv[1].endsWith("verify-redemption-chain.js"));

if (isMain) {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

  runVerifier(undefined, verbose)
    .then((report) => {
      process.exit(report.valid ? 0 : 1);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Fatal error: ${message}`);
      process.exit(1);
    });
}
