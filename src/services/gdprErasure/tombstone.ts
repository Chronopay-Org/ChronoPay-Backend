/**
 * tombstone.ts
 *
 * Implements the null-with-hash tombstone pattern for PII columns.
 *
 * ## Null-with-hash pattern
 *
 * When erasing a PII column:
 *  1. The original value is hashed with SHA-256 (hex).
 *  2. The PII column is set to NULL.
 *  3. If `storeHash` is true for that column a sibling column `hash_<name>`
 *     is set to the hash, preserving a tamper-evident record that the field
 *     existed without retaining the original value.
 *
 * The hash allows compliance teams to prove (for a known value) that a
 * specific record was erased, without reconstructing PII from the database.
 *
 * ## Dry-run mode
 *
 * When `dryRun = true` the engine builds the same SQL and collects planned
 * actions but never executes any statement against the database client.  This
 * lets auditors preview the erasure scope before committing.
 */

import crypto from "node:crypto";
import type { PoolClient } from "pg";
import type { PiiColumn } from "./dependencyGraph.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Describes one row-level tombstone action (for dry-run reporting). */
export interface TombstoneAction {
  table: string;
  rowId: string;
  nulledColumns: string[];
  hashedColumns: string[];
}

/** Result of tombstoning a single table for a subject. */
export interface TableTombstoneResult {
  table: string;
  rowsAffected: number;
  actions: TombstoneAction[];
}

// ─── Hash helper ──────────────────────────────────────────────────────────────

/**
 * Return the hex SHA-256 digest of the given string value.
 * The empty string and NULL are treated identically (hash of "").
 */
export function sha256Hex(value: string | null | undefined): string {
  const input = value ?? "";
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

// ─── Tombstone engine ─────────────────────────────────────────────────────────

/**
 * Options controlling tombstone behaviour.
 */
export interface TombstoneOptions {
  /** When true, build plan but execute no SQL mutations. */
  dryRun: boolean;
}

/**
 * Tombstone all PII columns for a subject's rows in the given table.
 *
 * The function:
 *  1. SELECTs the target rows (always executed, even in dry-run).
 *  2. For each row, computes hashes and builds a parameterised UPDATE.
 *  3. Executes the UPDATE inside the caller-managed transaction (skipped in
 *     dry-run).
 *
 * @param client       Active PostgreSQL transaction client.
 * @param table        Table name (safe — must be validated against the registry).
 * @param pkCol        Primary-key column name.
 * @param fkCol        Column used to filter rows by `subjectId`.
 * @param piiColumns   PII columns descriptor list.
 * @param subjectId    UUID of the data subject being erased.
 * @param options      Tombstone options (dry-run flag).
 */
export async function tombstoneTable(
  client: PoolClient,
  table: string,
  pkCol: string,
  fkCol: string,
  piiColumns: PiiColumn[],
  subjectId: string,
  options: TombstoneOptions,
): Promise<TableTombstoneResult> {
  // Filter to columns that actually exist in the result set.
  const effectiveColumns = piiColumns.filter((c) => c.name !== pkCol && c.name !== fkCol);

  if (effectiveColumns.length === 0) {
    return { table, rowsAffected: 0, actions: [] };
  }

  // Build SELECT to fetch current PII values.
  const selectCols = [pkCol, ...effectiveColumns.map((c) => c.name)].join(", ");
  // Note: table and column names are controlled by the internal registry, not
  // user input, so we do not need parameterised identifiers here.  We still
  // use a parameterised WHERE clause for the subject ID.
  const selectSql = `SELECT ${selectCols} FROM ${table} WHERE ${fkCol} = $1`;
  const selectResult = await client.query(selectSql, [subjectId]);

  if (selectResult.rows.length === 0) {
    return { table, rowsAffected: 0, actions: [] };
  }

  const actions: TombstoneAction[] = [];

  for (const row of selectResult.rows) {
    const rowId = String(row[pkCol]);
    const nulledColumns: string[] = [];
    const hashedColumns: string[] = [];

    // Build SET clause: col = NULL [, hash_col = $n]
    const setParts: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (const piiCol of effectiveColumns) {
      const originalValue = row[piiCol.name];
      // NULL the PII field.
      setParts.push(`${piiCol.name} = NULL`);
      nulledColumns.push(piiCol.name);

      if (piiCol.storeHash && originalValue !== null && originalValue !== undefined) {
        const hashValue = sha256Hex(String(originalValue));
        setParts.push(`hash_${piiCol.name} = $${paramIdx}`);
        params.push(hashValue);
        paramIdx++;
        hashedColumns.push(`hash_${piiCol.name}`);
      }
    }

    if (!options.dryRun) {
      // Add WHERE clause parameter.
      const updateSql = `
        UPDATE ${table}
        SET ${setParts.join(", ")}
        WHERE ${pkCol} = $${paramIdx}
      `;
      params.push(rowId);
      await client.query(updateSql, params);
    }

    actions.push({ table, rowId, nulledColumns, hashedColumns });
  }

  return {
    table,
    rowsAffected: options.dryRun ? 0 : selectResult.rows.length,
    actions,
  };
}
