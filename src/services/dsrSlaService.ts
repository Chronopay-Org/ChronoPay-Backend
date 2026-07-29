/**
 * DsrSlaService
 *
 * Manages GDPR Data-Subject Request (DSR) SLA lifecycle:
 *   - Create a new DSR with a 30-day due-at clock
 *   - Update status (in_progress, resolved, extended, rejected)
 *   - Query open requests ordered by due date
 *   - Compliance dashboard aggregates
 *   - Tiered alert detection (7 d / 3 d / 1 d remaining)
 *   - Mark individual alert tiers as sent
 *
 * The service is intentionally pure-function / stateless: all side-effects
 * (DB writes, audit log writes) are performed through injected dependencies
 * so tests can run without a real database or file system.
 */

import type { QueryResult } from "pg";
import { query as defaultQuery } from "../db/pool.js";
import { AuditLogger, defaultAuditLogger } from "./auditLogger.js";

// ─── SLA constants ───────────────────────────────────────────────────────────

/** GDPR Art. 12(3): one-calendar-month response window expressed in days. */
export const DSR_SLA_DAYS = 30;

/** Alert thresholds in whole days remaining. */
export const ALERT_THRESHOLDS = [7, 3, 1] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];

// ─── Domain types ─────────────────────────────────────────────────────────────

export type DsrRequestType =
  | "access"
  | "erasure"
  | "rectification"
  | "portability"
  | "restriction"
  | "objection";

export type DsrStatus =
  | "open"
  | "in_progress"
  | "resolved"
  | "extended"
  | "rejected";

export interface DsrRecord {
  id: string;
  subjectId: string;
  subjectEmail: string;
  requestType: DsrRequestType;
  receivedAt: Date;
  dueAt: Date;
  status: DsrStatus;
  extensionReason: string | null;
  alert7dSent: boolean;
  alert3dSent: boolean;
  alert1dSent: boolean;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionReason: string | null;
  resolutionEvidence: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Computed: milliseconds until due_at from the reference time. Negative = overdue. */
  msRemaining?: number;
  /** Computed: whole days remaining (floor). Negative = overdue. */
  daysRemaining?: number;
}

export interface CreateDsrInput {
  subjectId: string;
  subjectEmail: string;
  requestType: DsrRequestType;
  /** Override the clock-start; defaults to now. Useful for back-dating received paper requests. */
  receivedAt?: Date;
  notes?: string;
}

export interface ResolveInput {
  resolvedBy: string;
  resolutionReason: string;
  resolutionEvidence?: string;
}

export interface ExtendInput {
  extensionReason: string;
  /** How many additional days to extend (defaults to 30 — Art. 12(3) two-month extension). */
  additionalDays?: number;
}

export interface UpdateStatusInput {
  status: Exclude<DsrStatus, "resolved" | "extended">;
  notes?: string;
}

export interface DashboardSummary {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
  extended: number;
  rejected: number;
  overdue: number;
  dueIn7Days: number;
  dueIn3Days: number;
  dueIn1Day: number;
}

export interface ListDsrOptions {
  status?: DsrStatus | DsrStatus[];
  limit?: number;
  offset?: number;
  /** Include computed daysRemaining field relative to this timestamp (defaults to now). */
  now?: Date;
}

// ─── Repository interface (injected for testability) ─────────────────────────

/**
 * Minimal DB client shape. Matches the signature of `query` from `../db/pool.js`
 * so the real implementation is a direct pass-through, while tests inject a mock.
 */
export type QueryFn = (text: string, params?: unknown[]) => Promise<QueryResult>;

// ─── Row mapper ───────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): DsrRecord {
  return {
    id: row.id as string,
    subjectId: row.subject_id as string,
    subjectEmail: row.subject_email as string,
    requestType: row.request_type as DsrRequestType,
    receivedAt: new Date(row.received_at as string),
    dueAt: new Date(row.due_at as string),
    status: row.status as DsrStatus,
    extensionReason: (row.extension_reason as string) ?? null,
    alert7dSent: Boolean(row.alert_7d_sent),
    alert3dSent: Boolean(row.alert_3d_sent),
    alert1dSent: Boolean(row.alert_1d_sent),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
    resolvedBy: (row.resolved_by as string) ?? null,
    resolutionReason: (row.resolution_reason as string) ?? null,
    resolutionEvidence: (row.resolution_evidence as string) ?? null,
    notes: (row.notes as string) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function withCountdown(record: DsrRecord, now: Date): DsrRecord {
  const msRemaining = record.dueAt.getTime() - now.getTime();
  const daysRemaining = Math.floor(msRemaining / (1000 * 60 * 60 * 24));
  return { ...record, msRemaining, daysRemaining };
}

// ─── DsrSlaService ────────────────────────────────────────────────────────────

export class DsrSlaService {
  constructor(
    private readonly queryFn: QueryFn = defaultQuery,
    private readonly logger: AuditLogger = defaultAuditLogger,
  ) {}

  // ── Write: create ────────────────────────────────────────────────────────

  /**
   * Register a new data-subject request and start the 30-day SLA clock.
   *
   * `due_at` = `received_at` + {@link DSR_SLA_DAYS} calendar days.
   * Calendar arithmetic is intentional: a request received on Jan 31 is due
   * on Mar 2 (or Mar 3 in a leap year), not Feb 28.
   */
  async create(input: CreateDsrInput): Promise<DsrRecord> {
    const receivedAt = input.receivedAt ?? new Date();
    const dueAt = new Date(receivedAt);
    dueAt.setDate(dueAt.getDate() + DSR_SLA_DAYS);

    const result = await this.queryFn(
      `INSERT INTO dsr_sla
         (subject_id, subject_email, request_type, received_at, due_at, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.subjectId,
        input.subjectEmail,
        input.requestType,
        receivedAt.toISOString(),
        dueAt.toISOString(),
        input.notes ?? null,
      ],
    );

    const record = mapRow(result.rows[0]);

    await this.logger.log("dsr.created", {
      context: {
        dsrId: record.id,
        subjectId: record.subjectId,
        requestType: record.requestType,
        receivedAt: record.receivedAt.toISOString(),
        dueAt: record.dueAt.toISOString(),
      },
    });

    return record;
  }

  // ── Write: update status ─────────────────────────────────────────────────

  /** Transition a DSR to `in_progress` or `rejected`. */
  async updateStatus(id: string, input: UpdateStatusInput): Promise<DsrRecord> {
    const result = await this.queryFn(
      `UPDATE dsr_sla
          SET status = $2,
              notes  = COALESCE($3, notes)
        WHERE id = $1
        RETURNING *`,
      [id, input.status, input.notes ?? null],
    );

    if (result.rowCount === 0) {
      throw new Error(`DSR not found: ${id}`);
    }

    const record = mapRow(result.rows[0]);

    await this.logger.log("dsr.status_updated", {
      context: { dsrId: id, newStatus: input.status },
    });

    return record;
  }

  // ── Write: resolve ───────────────────────────────────────────────────────

  /**
   * Mark a DSR as resolved with a mandatory reason and evidence string.
   * Captures `resolved_at` = now and records the actor.
   */
  async resolve(id: string, input: ResolveInput): Promise<DsrRecord> {
    const resolvedAt = new Date();

    const result = await this.queryFn(
      `UPDATE dsr_sla
          SET status              = 'resolved',
              resolved_at         = $2,
              resolved_by         = $3,
              resolution_reason   = $4,
              resolution_evidence = $5
        WHERE id = $1
          AND status NOT IN ('resolved', 'rejected')
        RETURNING *`,
      [
        id,
        resolvedAt.toISOString(),
        input.resolvedBy,
        input.resolutionReason,
        input.resolutionEvidence ?? null,
      ],
    );

    if (result.rowCount === 0) {
      throw new Error(
        `DSR not found or already in a terminal state: ${id}`,
      );
    }

    const record = mapRow(result.rows[0]);

    await this.logger.log("dsr.resolved", {
      context: {
        dsrId: id,
        resolvedBy: input.resolvedBy,
        resolutionReason: input.resolutionReason,
        resolvedAt: resolvedAt.toISOString(),
      },
    });

    return record;
  }

  // ── Write: extend ────────────────────────────────────────────────────────

  /**
   * Apply a GDPR Art. 12(3) extension.  The default extension is 30 additional
   * days; callers may supply a custom count for the two-month variant.
   * Status is moved to `extended`; a second extension is permitted (some DPAs
   * allow consecutive extensions for complex requests).
   */
  async extend(id: string, input: ExtendInput): Promise<DsrRecord> {
    const additionalDays = input.additionalDays ?? DSR_SLA_DAYS;

    const result = await this.queryFn(
      `UPDATE dsr_sla
          SET status           = 'extended',
              due_at           = due_at + ($2 * INTERVAL '1 day'),
              extension_reason = $3
        WHERE id = $1
          AND status NOT IN ('resolved', 'rejected')
        RETURNING *`,
      [id, additionalDays, input.extensionReason],
    );

    if (result.rowCount === 0) {
      throw new Error(
        `DSR not found or already in a terminal state: ${id}`,
      );
    }

    const record = mapRow(result.rows[0]);

    await this.logger.log("dsr.extended", {
      context: {
        dsrId: id,
        additionalDays,
        newDueAt: record.dueAt.toISOString(),
        extensionReason: input.extensionReason,
      },
    });

    return record;
  }

  // ── Write: reopen ────────────────────────────────────────────────────────

  /**
   * Reopen a previously resolved/rejected DSR (e.g. after a regulatory
   * challenge).  The SLA clock restarts from now.
   */
  async reopen(id: string, reason: string): Promise<DsrRecord> {
    const now = new Date();
    const newDueAt = new Date(now);
    newDueAt.setDate(newDueAt.getDate() + DSR_SLA_DAYS);

    const result = await this.queryFn(
      `UPDATE dsr_sla
          SET status              = 'open',
              received_at         = $2,
              due_at              = $3,
              resolved_at         = NULL,
              resolved_by         = NULL,
              resolution_reason   = NULL,
              resolution_evidence = NULL,
              alert_7d_sent       = FALSE,
              alert_3d_sent       = FALSE,
              alert_1d_sent       = FALSE,
              notes               = COALESCE(notes || E'\\nReopened: ' || $4, $4)
        WHERE id = $1
        RETURNING *`,
      [id, now.toISOString(), newDueAt.toISOString(), reason],
    );

    if (result.rowCount === 0) {
      throw new Error(`DSR not found: ${id}`);
    }

    const record = mapRow(result.rows[0]);

    await this.logger.log("dsr.reopened", {
      context: {
        dsrId: id,
        reason,
        newReceivedAt: now.toISOString(),
        newDueAt: newDueAt.toISOString(),
      },
    });

    return record;
  }

  // ── Write: mark alert sent ───────────────────────────────────────────────

  /**
   * Idempotently mark that an alert for a given threshold has been dispatched.
   * Called by the scheduler after it fires the alert so the flag is never
   * re-set on subsequent poll cycles.
   */
  async markAlertSent(id: string, threshold: AlertThreshold): Promise<void> {
    const column =
      threshold === 7
        ? "alert_7d_sent"
        : threshold === 3
          ? "alert_3d_sent"
          : "alert_1d_sent";

    await this.queryFn(
      `UPDATE dsr_sla SET ${column} = TRUE WHERE id = $1`,
      [id],
    );
  }

  // ── Read: find by id ─────────────────────────────────────────────────────

  async findById(id: string, now?: Date): Promise<DsrRecord | null> {
    const result = await this.queryFn(
      `SELECT * FROM dsr_sla WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    const record = mapRow(result.rows[0]);
    return withCountdown(record, now ?? new Date());
  }

  // ── Read: list ───────────────────────────────────────────────────────────

  async list(options: ListDsrOptions = {}): Promise<DsrRecord[]> {
    const { limit = 50, offset = 0, now: nowArg } = options;
    const now = nowArg ?? new Date();

    const statuses = options.status
      ? Array.isArray(options.status)
        ? options.status
        : [options.status]
      : null;

    let sql: string;
    let params: unknown[];

    if (statuses) {
      // Build a parameterised IN clause
      const placeholders = statuses.map((_, i) => `$${i + 1}`).join(", ");
      sql = `
        SELECT * FROM dsr_sla
         WHERE status IN (${placeholders})
         ORDER BY due_at ASC
         LIMIT $${statuses.length + 1}
        OFFSET $${statuses.length + 2}`;
      params = [...statuses, limit, offset];
    } else {
      sql = `
        SELECT * FROM dsr_sla
         ORDER BY due_at ASC
         LIMIT $1 OFFSET $2`;
      params = [limit, offset];
    }

    const result = await this.queryFn(sql, params);
    return result.rows.map((row) => withCountdown(mapRow(row), now));
  }

  // ── Read: open requests due soon (scheduler hot path) ────────────────────

  /**
   * Return all non-terminal DSRs whose `due_at` is within `windowDays` from
   * `now`.  Ordered ascending so the most-urgent appear first.
   */
  async findDueSoon(windowDays: number, now?: Date): Promise<DsrRecord[]> {
    const ref = now ?? new Date();
    const cutoff = new Date(ref);
    cutoff.setDate(cutoff.getDate() + windowDays);

    const result = await this.queryFn(
      `SELECT * FROM dsr_sla
        WHERE status IN ('open', 'in_progress', 'extended')
          AND due_at <= $1
        ORDER BY due_at ASC`,
      [cutoff.toISOString()],
    );

    return result.rows.map((row) => withCountdown(mapRow(row), ref));
  }

  // ── Read: requests that need a specific alert fired ──────────────────────

  /**
   * Return DSRs that have crossed an alert threshold but have not yet had the
   * corresponding alert flag set to TRUE.  The scheduler calls this per
   * threshold so it can fire alerts in isolation.
   */
  async findPendingAlerts(threshold: AlertThreshold, now?: Date): Promise<DsrRecord[]> {
    const ref = now ?? new Date();
    const cutoff = new Date(ref);
    cutoff.setDate(cutoff.getDate() + threshold);

    const sentColumn =
      threshold === 7
        ? "alert_7d_sent"
        : threshold === 3
          ? "alert_3d_sent"
          : "alert_1d_sent";

    const result = await this.queryFn(
      `SELECT * FROM dsr_sla
        WHERE status IN ('open', 'in_progress', 'extended')
          AND due_at <= $1
          AND ${sentColumn} = FALSE
        ORDER BY due_at ASC`,
      [cutoff.toISOString()],
    );

    return result.rows.map((row) => withCountdown(mapRow(row), ref));
  }

  // ── Read: dashboard summary ───────────────────────────────────────────────

  /**
   * Single-query aggregate for the compliance dashboard.
   * Returns counts by status plus overdue and upcoming-alert buckets.
   */
  async getDashboardSummary(now?: Date): Promise<DashboardSummary> {
    const ref = now ?? new Date();

    const cutoff7d = new Date(ref);
    cutoff7d.setDate(cutoff7d.getDate() + 7);
    const cutoff3d = new Date(ref);
    cutoff3d.setDate(cutoff3d.getDate() + 3);
    const cutoff1d = new Date(ref);
    cutoff1d.setDate(cutoff1d.getDate() + 1);

    const result = await this.queryFn(
      `SELECT
          COUNT(*)                                                         AS total,
          COUNT(*) FILTER (WHERE status = 'open')                         AS open,
          COUNT(*) FILTER (WHERE status = 'in_progress')                  AS in_progress,
          COUNT(*) FILTER (WHERE status = 'resolved')                     AS resolved,
          COUNT(*) FILTER (WHERE status = 'extended')                     AS extended,
          COUNT(*) FILTER (WHERE status = 'rejected')                     AS rejected,
          COUNT(*) FILTER (
            WHERE status IN ('open', 'in_progress', 'extended')
              AND due_at < $1
          )                                                                AS overdue,
          COUNT(*) FILTER (
            WHERE status IN ('open', 'in_progress', 'extended')
              AND due_at >= $1 AND due_at <= $2
          )                                                                AS due_in_7_days,
          COUNT(*) FILTER (
            WHERE status IN ('open', 'in_progress', 'extended')
              AND due_at >= $1 AND due_at <= $3
          )                                                                AS due_in_3_days,
          COUNT(*) FILTER (
            WHERE status IN ('open', 'in_progress', 'extended')
              AND due_at >= $1 AND due_at <= $4
          )                                                                AS due_in_1_day
       FROM dsr_sla`,
      [
        ref.toISOString(),
        cutoff7d.toISOString(),
        cutoff3d.toISOString(),
        cutoff1d.toISOString(),
      ],
    );

    const row = result.rows[0] ?? {};
    return {
      total: Number(row.total ?? 0),
      open: Number(row.open ?? 0),
      inProgress: Number(row.in_progress ?? 0),
      resolved: Number(row.resolved ?? 0),
      extended: Number(row.extended ?? 0),
      rejected: Number(row.rejected ?? 0),
      overdue: Number(row.overdue ?? 0),
      dueIn7Days: Number(row.due_in_7_days ?? 0),
      dueIn3Days: Number(row.due_in_3_days ?? 0),
      dueIn1Day: Number(row.due_in_1_day ?? 0),
    };
  }
}

// Singleton for use by routes and the scheduler
export const dsrSlaService = new DsrSlaService();
