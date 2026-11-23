/**
 * reputationWriteAudit.ts
 * -----------------------
 * Append-only write helper for the reputation_events audit trail (#457).
 *
 * All reputation score mutations MUST go through `writeReputationScore` so
 * every change is captured with its actor, cause, and numeric delta.
 *
 * Design constraints
 * ------------------
 * - Append-only: no UPDATE or DELETE operations are issued. The DB table has
 *   a CHECK constraint on the `cause` column that the application also
 *   validates for defence-in-depth.
 * - cause_id is nullable — system-generated causes (e.g. decay ticks) may
 *   not have a source event identifier.
 * - Operates in-memory when `db` is not supplied (test/dev without a DB).
 * - All public methods are synchronous against the in-memory store;
 *   persistence to DB is async and callers should await it.
 */

import type { Pool } from "pg";

/** Allowed cause values — must mirror the DB CHECK constraint. */
export type ReputationEventCause =
  | "dispute"
  | "review"
  | "no_show"
  | "decay_tick"
  | "manual_override";

export const REPUTATION_EVENT_CAUSES: ReputationEventCause[] = [
  "dispute",
  "review",
  "no_show",
  "decay_tick",
  "manual_override",
];

export interface ReputationEvent {
  id: string;
  supplierId: string;
  actorId: string;
  cause: ReputationEventCause;
  /** Source event ID (dispute id, review id, …). Null for system causes. */
  causeId: string | null;
  /** Signed numeric delta — positive = improvement. */
  delta: number;
  scoreBefore: number;
  scoreAfter: number;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}

export interface WriteReputationScoreOptions {
  supplierId: string;
  actorId: string;
  cause: ReputationEventCause;
  causeId?: string | null;
  scoreBefore: number;
  scoreAfter: number;
  metadata?: Record<string, unknown>;
  /** Override the event timestamp for backfill/test purposes. */
  occurredAt?: Date;
}

export interface ListEventsOptions {
  supplierId: string;
  limit?: number;
  offset?: number;
  since?: Date;
  until?: Date;
}

export interface ListEventsResult {
  events: ReputationEvent[];
  total: number;
}

// ---------------------------------------------------------------------------
// In-memory store — used in tests and as a fallback when the DB is not wired.
// ---------------------------------------------------------------------------
let _store: ReputationEvent[] = [];

/** Test-isolation only — never call in production. */
export function _resetReputationEventStore(): void {
  _store = [];
}

function _nextId(): string {
  return `rpe-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Core write helper
// ---------------------------------------------------------------------------

/**
 * Append one reputation score change to the audit trail.
 *
 * @param opts   - Cause, actor, delta, and score snapshots.
 * @param db     - Optional pg Pool. When supplied the event is persisted to
 *                 the `reputation_events` table.  When absent (test/dev)
 *                 the event is written only to the in-memory store.
 * @returns      The newly created ReputationEvent.
 */
export async function writeReputationScore(
  opts: WriteReputationScoreOptions,
  db?: Pick<Pool, "query"> | null,
): Promise<ReputationEvent> {
  // Validate cause against the allowed enum (defence-in-depth on top of DB constraint).
  if (!REPUTATION_EVENT_CAUSES.includes(opts.cause)) {
    throw new Error(
      `Invalid reputation event cause: "${opts.cause}". ` +
        `Must be one of: ${REPUTATION_EVENT_CAUSES.join(", ")}.`,
    );
  }

  // Guard against null/whitespace actor_id — important for attribution.
  if (!opts.actorId || !opts.actorId.trim()) {
    throw new Error("actorId must be a non-empty string");
  }

  if (!opts.supplierId || !opts.supplierId.trim()) {
    throw new Error("supplierId must be a non-empty string");
  }

  const delta = opts.scoreAfter - opts.scoreBefore;
  const occurredAt = opts.occurredAt ?? new Date();

  if (db) {
    const row = await db.query<{
      id: string;
      supplier_id: string;
      actor_id: string;
      cause: ReputationEventCause;
      cause_id: string | null;
      delta: string;
      score_before: string;
      score_after: string;
      metadata: Record<string, unknown> | null;
      occurred_at: Date;
    }>(
      `INSERT INTO reputation_events
         (supplier_id, actor_id, cause, cause_id, delta, score_before, score_after, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        opts.supplierId.trim(),
        opts.actorId.trim(),
        opts.cause,
        opts.causeId ?? null,
        delta,
        opts.scoreBefore,
        opts.scoreAfter,
        opts.metadata ? JSON.stringify(opts.metadata) : null,
        occurredAt.toISOString(),
      ],
    );
    const r = row.rows[0];
    return {
      id: r.id,
      supplierId: r.supplier_id,
      actorId: r.actor_id,
      cause: r.cause,
      causeId: r.cause_id,
      delta: parseFloat(r.delta),
      scoreBefore: parseFloat(r.score_before),
      scoreAfter: parseFloat(r.score_after),
      metadata: r.metadata ?? undefined,
      occurredAt: new Date(r.occurred_at),
    };
  }

  // In-memory fallback.
  const event: ReputationEvent = {
    id: _nextId(),
    supplierId: opts.supplierId.trim(),
    actorId: opts.actorId.trim(),
    cause: opts.cause,
    causeId: opts.causeId ?? null,
    delta,
    scoreBefore: opts.scoreBefore,
    scoreAfter: opts.scoreAfter,
    metadata: opts.metadata,
    occurredAt,
  };
  _store.push(event);
  return event;
}

// ---------------------------------------------------------------------------
// Read helper — used by the operator inspection endpoint
// ---------------------------------------------------------------------------

/**
 * List reputation events for a given supplier, newest-first.
 *
 * @param opts - Filter and pagination options.
 * @param db   - Optional pg Pool.
 */
export async function listReputationEvents(
  opts: ListEventsOptions,
  db?: Pick<Pool, "query"> | null,
): Promise<ListEventsResult> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  if (db) {
    const conditions: string[] = ["supplier_id = $1"];
    const params: unknown[] = [opts.supplierId];
    let paramIdx = 2;

    if (opts.since) {
      conditions.push(`occurred_at >= $${paramIdx++}`);
      params.push(opts.since.toISOString());
    }
    if (opts.until) {
      conditions.push(`occurred_at <= $${paramIdx++}`);
      params.push(opts.until.toISOString());
    }

    const where = conditions.join(" AND ");
    const countRow = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reputation_events WHERE ${where}`,
      params,
    );
    const total = parseInt(countRow.rows[0]?.count ?? "0", 10);

    const rows = await db.query<{
      id: string;
      supplier_id: string;
      actor_id: string;
      cause: ReputationEventCause;
      cause_id: string | null;
      delta: string;
      score_before: string;
      score_after: string;
      metadata: Record<string, unknown> | null;
      occurred_at: Date;
    }>(
      `SELECT * FROM reputation_events
        WHERE ${where}
        ORDER BY occurred_at DESC
        LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      [...params, limit, offset],
    );

    return {
      total,
      events: rows.rows.map((r) => ({
        id: r.id,
        supplierId: r.supplier_id,
        actorId: r.actor_id,
        cause: r.cause,
        causeId: r.cause_id,
        delta: parseFloat(r.delta),
        scoreBefore: parseFloat(r.score_before),
        scoreAfter: parseFloat(r.score_after),
        metadata: r.metadata ?? undefined,
        occurredAt: new Date(r.occurred_at),
      })),
    };
  }

  // In-memory fallback.
  let filtered = _store.filter((e) => e.supplierId === opts.supplierId);
  if (opts.since) {
    filtered = filtered.filter((e) => e.occurredAt >= opts.since!);
  }
  if (opts.until) {
    filtered = filtered.filter((e) => e.occurredAt <= opts.until!);
  }
  // Newest-first.
  filtered.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  return {
    total: filtered.length,
    events: filtered.slice(offset, offset + limit),
  };
}
