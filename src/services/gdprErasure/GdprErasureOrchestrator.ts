/**
 * GdprErasureOrchestrator.ts
 *
 * High-level orchestrator for GDPR Article 17 ("right to erasure") requests.
 *
 * ## Responsibilities
 *
 * 1. **Legal-hold guard** — refuses erasure for subjects under a legal hold.
 * 2. **Dependency graph walk** — processes tables in topological order (leaf
 *    tables first, root `users` row last) to respect FK constraints.
 * 3. **Null-with-hash tombstoning** — nulls PII columns, preserving SHA-256
 *    hashes where configured.
 * 4. **Transactional rollback** — runs all mutations inside a single DB
 *    transaction; any failure triggers a full rollback for this subject.
 * 5. **Erasure receipt** — writes a structured receipt to `gdpr_erasure_events`
 *    after a successful (or dry-run) erasure.
 * 6. **Audit logging** — emits `gdpr.erasure.requested`, `gdpr.erasure.completed`,
 *    and `gdpr.erasure.failed` events via `AuditLogger`.
 * 7. **Dry-run mode** — collects a full plan of actions without committing any
 *    database mutations; the receipt is still written (with `dryRun: true`).
 *
 * ## Usage
 *
 * ```ts
 * const orchestrator = new GdprErasureOrchestrator();
 * const receipt = await orchestrator.erase({
 *   subjectId: 'user-uuid',
 *   requestedBy: 'admin-uuid',
 *   dryRun: false,
 * });
 * ```
 *
 * ## Dependency injection
 *
 * All external dependencies (DB pool, legal-hold check, audit logger, event
 * log, graph) are injected so the orchestrator is fully unit-testable without
 * a real database.
 */

import crypto from "node:crypto";
import pool from "../../db/pool.js";
import type { PoolClient } from "pg";
import { LegalHoldService } from "../legalHoldService.js";
import { AuditLogger, defaultAuditLogger } from "../auditLogger.js";
import { getSortedGraph, type TableNode } from "./dependencyGraph.js";
import { tombstoneTable, type TableTombstoneResult } from "./tombstone.js";
import {
  type ErasureEventLog,
  type ErasureReceipt,
  PgErasureEventLog,
} from "./eventLog.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Input parameters for an erasure request. */
export interface ErasureRequest {
  /** UUID of the data subject to erase. */
  subjectId: string;
  /** ID of the actor (admin) initiating the request. */
  requestedBy: string;
  /**
   * When true the orchestrator plans but does not execute any SQL mutations.
   * A receipt (with `dryRun: true`) is still written for the audit trail.
   */
  dryRun: boolean;
}

/** Detailed result including the receipt and per-table action plan. */
export interface ErasureResult {
  receipt: ErasureReceipt;
  /** Ordered list of per-table tombstone results (useful for dry-run previews). */
  tableResults: TableTombstoneResult[];
}

// ─── LegalHold port ───────────────────────────────────────────────────────────

/**
 * Minimal interface for checking legal holds, allowing injection of a test
 * double without depending on the concrete `LegalHoldService`.
 */
export interface LegalHoldChecker {
  isHeld(subjectId: string): Promise<boolean>;
}

// ─── Pool port ────────────────────────────────────────────────────────────────

/**
 * Minimal pool interface required by the orchestrator.
 */
export interface DbPool {
  connect(): Promise<PoolClient>;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when an erasure is attempted for a subject under a legal hold.
 */
export class LegalHoldViolationError extends Error {
  constructor(public readonly subjectId: string) {
    super(`Erasure blocked: subject ${subjectId} is under a legal hold.`);
    this.name = "LegalHoldViolationError";
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class GdprErasureOrchestrator {
  private readonly pool: DbPool;
  private readonly legalHold: LegalHoldChecker;
  private readonly auditLogger: AuditLogger;
  private readonly getGraph: () => TableNode[];

  constructor(opts?: {
    pool?: DbPool;
    legalHold?: LegalHoldChecker;
    auditLogger?: AuditLogger;
    getGraph?: () => TableNode[];
    /** Override the event log (e.g. for testing). */
    eventLog?: ErasureEventLog;
  }) {
    this.pool = opts?.pool ?? (pool as unknown as DbPool);
    this.legalHold = opts?.legalHold ?? LegalHoldService;
    this.auditLogger = opts?.auditLogger ?? defaultAuditLogger;
    this.getGraph = opts?.getGraph ?? getSortedGraph;
    this._eventLogOverride = opts?.eventLog;
  }

  /** Optional event log override (dependency injection for tests). */
  private readonly _eventLogOverride?: ErasureEventLog;

  /**
   * Execute a GDPR erasure for the given subject.
   *
   * @throws {LegalHoldViolationError}  if the subject has an active legal hold.
   * @throws any DB errors if the transaction cannot be committed (rolled back).
   */
  public async erase(request: ErasureRequest): Promise<ErasureResult> {
    const { subjectId, requestedBy, dryRun } = request;

    await this.auditLogger.log(
      "gdpr.erasure.requested",
      {
        context: { subjectId, requestedBy, dryRun },
      },
      { status: 202 },
    );

    // ── Legal-hold guard ──────────────────────────────────────────────────────
    const held = await this.legalHold.isHeld(subjectId);
    if (held) {
      await this.auditLogger.log(
        "gdpr.erasure.blocked.legalhold",
        { context: { subjectId, requestedBy } },
        { status: 409 },
      );
      throw new LegalHoldViolationError(subjectId);
    }

    // ── Obtain transaction client ─────────────────────────────────────────────
    const client = await this.pool.connect();
    const tableResults: TableTombstoneResult[] = [];

    try {
      if (!dryRun) {
        await client.query("BEGIN");
      }

      // ── Walk the FK graph ───────────────────────────────────────────────────
      const graph = this.getGraph();
      for (const node of graph) {
        const result = await tombstoneTable(
          client,
          node.table,
          node.pkCol,
          node.fkCol,
          node.piiColumns,
          subjectId,
          { dryRun },
        );
        tableResults.push(result);
      }

      // ── Build and write the receipt ─────────────────────────────────────────
      const receiptId = crypto.randomUUID();
      const erasedAt = new Date().toISOString();
      const tablesAffected = tableResults
        .filter((r) => r.actions.length > 0 || r.rowsAffected > 0)
        .map((r) => ({
          table: r.table,
          rowsAffected: dryRun ? r.actions.length : r.rowsAffected,
        }));

      const receipt: ErasureReceipt = {
        receiptId,
        subjectId,
        erasedAt,
        tablesAffected,
        totalRowsAffected: tablesAffected.reduce((sum, t) => sum + t.rowsAffected, 0),
        dryRun,
        requestedBy,
      };

      // Write receipt — within transaction for live runs, outside for dry-runs.
      const eventLog: ErasureEventLog =
        this._eventLogOverride ??
        (dryRun ? new PgErasureEventLog() : new PgErasureEventLog(client));

      await eventLog.writeReceipt(receipt);

      // ── Commit ───────────────────────────────────────────────────────────────
      if (!dryRun) {
        await client.query("COMMIT");
      }

      await this.auditLogger.log(
        "gdpr.erasure.completed",
        {
          context: {
            receiptId,
            subjectId,
            requestedBy,
            dryRun,
            tablesAffected: tablesAffected.length,
            totalRowsAffected: receipt.totalRowsAffected,
          },
        },
        { status: 200 },
      );

      return { receipt, tableResults };
    } catch (error) {
      if (!dryRun) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Swallow rollback errors; the original error takes precedence.
        }
      }

      await this.auditLogger.log(
        "gdpr.erasure.failed",
        {
          context: {
            subjectId,
            requestedBy,
            dryRun,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        { status: 500 },
      );

      throw error;
    } finally {
      client.release();
    }
  }
}

/** Default singleton for application-wide use. */
export const defaultGdprErasureOrchestrator = new GdprErasureOrchestrator();
