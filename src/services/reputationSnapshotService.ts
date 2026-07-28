/**
 * reputationSnapshotService.ts
 * ----------------------------
 * Daily snapshot job and time-series read interface for supplier reputation
 * scores (#458).
 *
 * The job freezes the current score for every known supplier at a fixed UTC
 * time each day, including the tier boundaries active at snapshot time so
 * historical charts remain accurate even if thresholds change later.
 *
 * Design constraints
 * ------------------
 * - Idempotent: INSERT … ON CONFLICT DO NOTHING — re-running for the same
 *   (supplier_id, snapshot_date) is safe.
 * - Missed-day recovery: call `runSnapshotJob` with `snapshotDate` set to the
 *   missed date to backfill without re-running for today.
 * - In-memory fallback when db is absent (test/dev).
 * - job_run_id links every row back to a scheduler invocation.
 */

import type { Pool } from "pg";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TierBoundaries {
  excellent: number;
  good: number;
  needs_improvement: number;
  poor: number;
}

export const DEFAULT_TIER_BOUNDARIES: TierBoundaries = {
  excellent: 90,
  good: 70,
  needs_improvement: 50,
  poor: 0,
};

export type TierLabel = "excellent" | "good" | "needs_improvement" | "poor" | "insufficient_data";

export function computeTierLabel(score: number, boundaries: TierBoundaries): TierLabel {
  if (score >= boundaries.excellent) return "excellent";
  if (score >= boundaries.good) return "good";
  if (score >= boundaries.needs_improvement) return "needs_improvement";
  return "poor";
}

export interface ReputationSnapshot {
  id: string;
  supplierId: string;
  snapshotDate: string; // ISO date string YYYY-MM-DD
  score: number;
  tierLabel: TierLabel;
  tierBoundaries: TierBoundaries;
  jobRunId: string;
  createdAt: Date;
}

export interface SupplierScoreSource {
  supplierId: string;
  score: number;
}

export interface SnapshotJobResult {
  jobRunId: string;
  snapshotDate: string;
  written: number;
  skipped: number;
}

export interface ListSnapshotsOptions {
  supplierId?: string;
  since?: string; // YYYY-MM-DD
  until?: string; // YYYY-MM-DD
  limit?: number;
  offset?: number;
}

export interface ListSnapshotsResult {
  snapshots: ReputationSnapshot[];
  total: number;
}

// ---------------------------------------------------------------------------
// In-memory store (test/dev fallback)
// ---------------------------------------------------------------------------

let _snapshotStore: ReputationSnapshot[] = [];

/** Test-isolation only — never call in production. */
export function _resetSnapshotStore(): void {
  _snapshotStore = [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Date as a YYYY-MM-DD string in UTC. */
function toUtcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Snapshot job
// ---------------------------------------------------------------------------

/**
 * Run the daily snapshot job.
 *
 * @param suppliers     - List of supplier IDs and their current scores.
 *                        In production this comes from the reputation service.
 * @param snapshotDate  - UTC date to freeze (defaults to today).  Pass a
 *                        specific date for backfills.
 * @param tierBoundaries - Active tier thresholds at job time.
 * @param db            - Optional pg Pool for persistence.
 * @returns             - Summary of rows written / skipped.
 */
export async function runSnapshotJob(
  suppliers: SupplierScoreSource[],
  snapshotDate?: Date,
  tierBoundaries: TierBoundaries = DEFAULT_TIER_BOUNDARIES,
  db?: Pick<Pool, "query"> | null,
): Promise<SnapshotJobResult> {
  const jobRunId = randomUUID();
  const date = snapshotDate ?? new Date();
  const dateStr = toUtcDateString(date);

  let written = 0;
  let skipped = 0;

  for (const { supplierId, score } of suppliers) {
    const tierLabel = computeTierLabel(score, tierBoundaries);

    if (db) {
      const result = await db.query(
        `INSERT INTO reputation_snapshots
           (supplier_id, snapshot_date, score, tier_label, tier_boundaries, job_run_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (supplier_id, snapshot_date) DO NOTHING
         RETURNING id`,
        [
          supplierId,
          dateStr,
          score,
          tierLabel,
          JSON.stringify(tierBoundaries),
          jobRunId,
        ],
      );
      if (result.rowCount && result.rowCount > 0) {
        written++;
      } else {
        skipped++;
      }
    } else {
      // In-memory: check for existing snapshot.
      const exists = _snapshotStore.some(
        (s) => s.supplierId === supplierId && s.snapshotDate === dateStr,
      );
      if (exists) {
        skipped++;
      } else {
        _snapshotStore.push({
          id: randomUUID(),
          supplierId,
          snapshotDate: dateStr,
          score,
          tierLabel,
          tierBoundaries,
          jobRunId,
          createdAt: new Date(),
        });
        written++;
      }
    }
  }

  return { jobRunId, snapshotDate: dateStr, written, skipped };
}

// ---------------------------------------------------------------------------
// Time-series read
// ---------------------------------------------------------------------------

/**
 * Query the snapshot history for one or all suppliers.
 *
 * @param opts - Filters and pagination.
 * @param db   - Optional pg Pool.
 */
export async function listReputationSnapshots(
  opts: ListSnapshotsOptions,
  db?: Pick<Pool, "query"> | null,
): Promise<ListSnapshotsResult> {
  const limit = Math.min(opts.limit ?? 90, 365);
  const offset = opts.offset ?? 0;

  if (db) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (opts.supplierId) {
      conditions.push(`supplier_id = $${idx++}`);
      params.push(opts.supplierId);
    }
    if (opts.since) {
      conditions.push(`snapshot_date >= $${idx++}`);
      params.push(opts.since);
    }
    if (opts.until) {
      conditions.push(`snapshot_date <= $${idx++}`);
      params.push(opts.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reputation_snapshots ${where}`,
      params,
    );
    const total = parseInt(countRow.rows[0]?.count ?? "0", 10);

    const rows = await db.query<{
      id: string;
      supplier_id: string;
      snapshot_date: string;
      score: string;
      tier_label: TierLabel;
      tier_boundaries: TierBoundaries;
      job_run_id: string;
      created_at: Date;
    }>(
      `SELECT * FROM reputation_snapshots ${where}
        ORDER BY snapshot_date DESC, supplier_id
        LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset],
    );

    return {
      total,
      snapshots: rows.rows.map((r) => ({
        id: r.id,
        supplierId: r.supplier_id,
        snapshotDate: r.snapshot_date,
        score: parseFloat(r.score),
        tierLabel: r.tier_label,
        tierBoundaries: r.tier_boundaries,
        jobRunId: r.job_run_id,
        createdAt: new Date(r.created_at),
      })),
    };
  }

  // In-memory fallback.
  let filtered = [..._snapshotStore];
  if (opts.supplierId) {
    filtered = filtered.filter((s) => s.supplierId === opts.supplierId);
  }
  if (opts.since) {
    filtered = filtered.filter((s) => s.snapshotDate >= opts.since!);
  }
  if (opts.until) {
    filtered = filtered.filter((s) => s.snapshotDate <= opts.until!);
  }

  // Newest-first.
  filtered.sort((a, b) =>
    b.snapshotDate < a.snapshotDate ? -1 : b.snapshotDate > a.snapshotDate ? 1 : 0,
  );

  return {
    total: filtered.length,
    snapshots: filtered.slice(offset, offset + limit),
  };
}
