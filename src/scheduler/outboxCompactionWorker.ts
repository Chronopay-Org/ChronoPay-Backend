/**
 * outboxCompactionWorker.ts
 *
 * Compacts the `outbox_events` table by deleting rows that have been
 * acknowledged by the downstream consumer AND whose `acked_at` timestamp is
 * older than the configured retention window.
 *
 * Design decisions:
 *  - Operates against an in-memory row store (OutboxStore) injected at call
 *    time so the worker is fully testable without a real database.
 *  - A safety threshold prevents accidental mass-deletes: if the number of
 *    compaction candidates exceeds the threshold the sweep is skipped and a
 *    metric is incremented.
 *  - Configuration is read from environment variables with safe defaults so
 *    the worker can be tuned per-environment without code changes.
 *  - The worker loop honours an AbortSignal for clean shutdown (mirrors the
 *    expiryCleanupWorker pattern already in the codebase).
 *  - All compaction activity is reflected in Prometheus metrics for
 *    observability.
 */

import { type Pool } from "pg";
import {
  outboxCompactionRowsDeleted,
  outboxCompactionSafetyBrakeTriggers,
  outboxCompactionDurationMs,
} from "../metrics.js";
import type { InMemoryOutboxStore, OutboxEvent } from "../services/outboxRelay.js";

export { InMemoryOutboxStore } from "../services/outboxRelay.js";

// ─── Store interface & SQL implementation ─────────────────────────────────────

export interface OutboxCompactionStore {
  /** Count acked rows older than the given retention window (in ms). */
  countCandidates(retentionMs: number): Promise<number>;
  /** Delete up to `batchSize` acked rows older than the given retention window (in ms). */
  deleteBatch(retentionMs: number, batchSize: number): Promise<number>;
}

/**
 * Production SQL-backed outbox compaction store.
 *
 * Deletes acknowledged rows older than the configured retention window in
 * bounded batches while never touching un-acked rows (`acked_at IS NULL`).
 */
export class SqlOutboxCompactionStore implements OutboxCompactionStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async countCandidates(retentionMs: number): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM outbox_events
       WHERE acked_at IS NOT NULL
         AND acked_at < NOW() - ($1 * INTERVAL '1 millisecond')`,
      [retentionMs],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async deleteBatch(retentionMs: number, batchSize: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM outbox_events
       WHERE id IN (
         SELECT id
         FROM outbox_events
         WHERE acked_at IS NOT NULL
           AND acked_at < NOW() - ($1 * INTERVAL '1 millisecond')
         ORDER BY acked_at ASC
         LIMIT $2
       )`,
      [retentionMs, batchSize],
    );
    return result.rowCount ?? 0;
  }
}

function isAsyncCompactionStore(
  store: Pick<InMemoryOutboxStore, "list" | "delete"> | OutboxCompactionStore,
): store is OutboxCompactionStore {
  return (
    typeof (store as OutboxCompactionStore).countCandidates === "function" &&
    typeof (store as OutboxCompactionStore).deleteBatch === "function"
  );
}

// ─── Domain types ─────────────────────────────────────────────────────────────

/**
 * Minimal representation of an outbox event row used by the compaction worker.
 * Real implementations back this with the `outbox_events` table; tests use
 * an in-memory store.
 */
export type OutboxRow = OutboxEvent;

// ─── Configuration ────────────────────────────────────────────────────────────

export interface OutboxCompactionConfig {
  /**
   * Minimum age (in milliseconds) that an acked row must reach before it is
   * eligible for deletion.  Defaults to 7 days (OUTBOX_RETENTION_MS env var).
   */
  retentionMs?: number;
  /**
   * Maximum number of rows the worker will delete in a single sweep.
   * Acts as a rate-limit on I/O.  Defaults to 500 (OUTBOX_COMPACTION_BATCH_SIZE).
   */
  batchSize?: number;
  /**
   * If the total number of eligible rows exceeds this value the sweep is
   * skipped entirely and a safety-brake metric is fired.  This prevents
   * accidental mass-deletes when a retention window is changed mid-flight.
   * Defaults to 10 000 (OUTBOX_COMPACTION_SAFETY_THRESHOLD).
   */
  safetyThreshold?: number;
  /**
   * How long the worker sleeps between sweeps in milliseconds.
   * Defaults to 60 000 ms / 1 minute (OUTBOX_COMPACTION_INTERVAL_MS).
   */
  intervalMs?: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return defaultValue;
  return parsed;
}

function resolveConfig(
  overrides: OutboxCompactionConfig = {},
): Required<OutboxCompactionConfig> {
  return {
    retentionMs:
      overrides.retentionMs ??
      parsePositiveInteger(process.env.OUTBOX_RETENTION_MS, SEVEN_DAYS_MS),
    batchSize:
      overrides.batchSize ??
      parsePositiveInteger(process.env.OUTBOX_COMPACTION_BATCH_SIZE, 500),
    safetyThreshold:
      overrides.safetyThreshold ??
      parsePositiveInteger(process.env.OUTBOX_COMPACTION_SAFETY_THRESHOLD, 10_000),
    intervalMs:
      overrides.intervalMs ??
      parsePositiveInteger(process.env.OUTBOX_COMPACTION_INTERVAL_MS, 60_000),
  };
}

// ─── Result type ─────────────────────────────────────────────────────────────

export interface OutboxCompactionResult {
  /** Number of rows deleted in this sweep. */
  deleted: number;
  /** True when the safety brake fired and no rows were deleted. */
  skippedBecauseThreshold?: boolean;
}

// ─── Core compaction logic ────────────────────────────────────────────────────

async function compactOutboxOnceAsync(
  store: OutboxCompactionStore,
  config: OutboxCompactionConfig = {},
): Promise<OutboxCompactionResult> {
  const cfg = resolveConfig(config);
  const candidateCount = await store.countCandidates(cfg.retentionMs);

  if (candidateCount > cfg.safetyThreshold) {
    outboxCompactionSafetyBrakeTriggers.inc();
    return { deleted: 0, skippedBecauseThreshold: true };
  }

  const sweepStart = Date.now();
  const deleted =
    candidateCount === 0
      ? 0
      : await store.deleteBatch(cfg.retentionMs, cfg.batchSize);

  const elapsed = Date.now() - sweepStart;
  outboxCompactionDurationMs.observe(elapsed);

  if (deleted > 0) {
    outboxCompactionRowsDeleted.inc(deleted);
  }

  return { deleted };
}

/**
 * Perform a single compaction sweep against the provided store.
 *
 * Candidates are rows where:
 *   acked_at IS NOT NULL  AND  acked_at < (nowMs - retentionMs)
 *
 * @param store   The outbox row store to compact.
 * @param config  Optional configuration overrides.
 * @param nowMs   Current time in epoch milliseconds (injectable for testing).
 */
export function compactOutboxOnce(
  store: Pick<InMemoryOutboxStore, "list" | "delete">,
  config?: OutboxCompactionConfig,
  nowMs?: number,
): OutboxCompactionResult;
export function compactOutboxOnce(
  store: OutboxCompactionStore,
  config?: OutboxCompactionConfig,
  nowMs?: number,
): Promise<OutboxCompactionResult>;
export function compactOutboxOnce(
  store: Pick<InMemoryOutboxStore, "list" | "delete"> | OutboxCompactionStore,
  config: OutboxCompactionConfig = {},
  nowMs: number = Date.now(),
): OutboxCompactionResult | Promise<OutboxCompactionResult> {
  if (isAsyncCompactionStore(store)) {
    return compactOutboxOnceAsync(store, config);
  }

  const cfg = resolveConfig(config);
  const cutoff = nowMs - cfg.retentionMs;

  const candidates = store
    .list()
    .filter(
      (row) => row.acked_at !== null && row.acked_at.getTime() < cutoff,
    );

  if (candidates.length > cfg.safetyThreshold) {
    outboxCompactionSafetyBrakeTriggers.inc();
    return { deleted: 0, skippedBecauseThreshold: true };
  }

  const sweepStart = Date.now();
  const batch = candidates.slice(0, cfg.batchSize);

  for (const row of batch) {
    store.delete(row.id);
  }

  const elapsed = Date.now() - sweepStart;
  outboxCompactionDurationMs.observe(elapsed);

  if (batch.length > 0) {
    outboxCompactionRowsDeleted.inc(batch.length);
  }

  return { deleted: batch.length };
}

// ─── Long-running worker loop ─────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Continuously compact the outbox table until the given AbortSignal fires.
 *
 * @param signal  AbortSignal that stops the worker cleanly.
 * @param store   The outbox row store to compact.
 * @param config  Optional configuration overrides.
 */
export async function runOutboxCompactionWorker(
  signal: AbortSignal,
  store: Pick<InMemoryOutboxStore, "list" | "delete"> | OutboxCompactionStore,
  config: OutboxCompactionConfig = {},
): Promise<void> {
  const cfg = resolveConfig(config);

  while (!signal.aborted) {
    if (isAsyncCompactionStore(store)) {
      await compactOutboxOnce(store, config);
    } else {
      compactOutboxOnce(store, config);
    }
    if (signal.aborted) break;
    await sleep(cfg.intervalMs, signal);
  }
}
