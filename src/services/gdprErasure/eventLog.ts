/**
 * eventLog.ts
 *
 * Writes and reads GDPR erasure receipts to/from the `gdpr_erasure_events`
 * table.
 *
 * ## Receipt schema
 *
 * A receipt captures the full audit trail of an erasure run:
 *  - Who was erased (subjectId)
 *  - When the erasure occurred (erasedAt ISO timestamp)
 *  - Which tables were affected and how many rows
 *  - Whether this was a dry-run preview
 *  - A stable receiptId (UUID) for downstream reference
 *
 * ## In-memory implementation
 *
 * `InMemoryErasureEventLog` mirrors the real DB implementation for unit tests.
 * Both implement the `ErasureEventLog` interface so services can accept either.
 */

import type { PoolClient } from "pg";
import { query } from "../../db/pool.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-table summary included in the receipt. */
export interface TableErasureSummary {
  table: string;
  rowsAffected: number;
}

/** Full erasure receipt written to the event log. */
export interface ErasureReceipt {
  receiptId: string;
  subjectId: string;
  erasedAt: string;
  tablesAffected: TableErasureSummary[];
  totalRowsAffected: number;
  dryRun: boolean;
  requestedBy: string;
}

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * Abstraction over the erasure event log store.
 * Implemented by `PgErasureEventLog` (production) and
 * `InMemoryErasureEventLog` (tests).
 */
export interface ErasureEventLog {
  /**
   * Persist an erasure receipt.
   * In dry-run mode the receipt is still written so auditors can review plans.
   */
  writeReceipt(receipt: ErasureReceipt): Promise<void>;

  /**
   * Retrieve all receipts for a given subjectId, ordered by erasedAt descending.
   */
  getReceiptsForSubject(subjectId: string): Promise<ErasureReceipt[]>;
}

// ─── In-memory implementation (tests) ─────────────────────────────────────────

/**
 * In-memory implementation of `ErasureEventLog` for use in unit tests.
 */
export class InMemoryErasureEventLog implements ErasureEventLog {
  private readonly receipts: ErasureReceipt[] = [];

  async writeReceipt(receipt: ErasureReceipt): Promise<void> {
    this.receipts.push({ ...receipt });
  }

  async getReceiptsForSubject(subjectId: string): Promise<ErasureReceipt[]> {
    return this.receipts
      .filter((r) => r.subjectId === subjectId)
      .sort((a, b) => b.erasedAt.localeCompare(a.erasedAt));
  }

  /** Remove all entries (test isolation). */
  clear(): void {
    this.receipts.length = 0;
  }

  /** Return a snapshot of all stored receipts (test introspection). */
  all(): readonly ErasureReceipt[] {
    return [...this.receipts];
  }
}

// ─── PostgreSQL implementation (production) ───────────────────────────────────

/**
 * PostgreSQL-backed `ErasureEventLog`.
 *
 * Writes and reads from `gdpr_erasure_events`.  An optional `PoolClient` can
 * be supplied so writes participate in the caller's transaction.
 */
export class PgErasureEventLog implements ErasureEventLog {
  constructor(private readonly txClient?: PoolClient) {}

  async writeReceipt(receipt: ErasureReceipt): Promise<void> {
    const sql = `
      INSERT INTO gdpr_erasure_events
        (receipt_id, subject_id, erased_at, receipt, dry_run, requested_by)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    const params = [
      receipt.receiptId,
      receipt.subjectId,
      receipt.erasedAt,
      JSON.stringify(receipt),
      receipt.dryRun,
      receipt.requestedBy,
    ];

    if (this.txClient) {
      await this.txClient.query(sql, params);
    } else {
      await query(sql, params);
    }
  }

  async getReceiptsForSubject(subjectId: string): Promise<ErasureReceipt[]> {
    const sql = `
      SELECT receipt
      FROM gdpr_erasure_events
      WHERE subject_id = $1
      ORDER BY erased_at DESC
    `;

    let result;
    if (this.txClient) {
      result = await this.txClient.query(sql, [subjectId]);
    } else {
      result = await query(sql, [subjectId]);
    }

    return result.rows.map((row) => row.receipt as ErasureReceipt);
  }
}
