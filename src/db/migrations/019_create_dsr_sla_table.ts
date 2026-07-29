import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 019 — create_dsr_sla_table
 *
 * GDPR Data-Subject Request (DSR) SLA tracker.
 *
 * Regulatory context: GDPR Art. 12(3) requires controllers to respond to
 * data-subject requests within one calendar month (≤ 30 days), extendable
 * by a further two months for complex/numerous requests. This table tracks
 * every DSR from receipt through resolution and drives the countdown-alert
 * scheduler.
 *
 * Design decisions:
 *   - `received_at` is the clock-start for the 30-day SLA.
 *   - `due_at` is computed by the application (received_at + 30 days) and
 *     stored explicitly so queries stay simple and the value is immutable
 *     once written.  Extensions bump `due_at` and record the reason in
 *     `extension_reason`.
 *   - `status` drives the scheduler: only open/in-progress rows are polled.
 *   - `alert_7d_sent`, `alert_3d_sent`, `alert_1d_sent` are simple boolean
 *     flags so the scheduler can fire-and-forget without a separate alerts
 *     table (keeps the join count zero for the hot dashboard query).
 *   - `resolved_at`, `resolution_reason`, `resolution_evidence` record the
 *     audit trail required by Art. 5(2) accountability.
 *   - `subject_email` is encrypted-at-rest at the application layer; this
 *     migration stores only the ciphertext column.
 *   - `request_type` is an enum-like CHECK constraint so new types require a
 *     deliberate migration.
 *   - Indexes cover: open requests by due date (scheduler hot path),
 *     subject lookups (compliance review), and status filtering.
 */
export const migration: Migration = {
  id: "019",
  name: "create_dsr_sla_table",

  async up(client: PoolClient): Promise<void> {
    // Main DSR tracking table
    await client.query(`
      CREATE TABLE dsr_sla (
        id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

        -- Who filed the request
        subject_id          TEXT        NOT NULL,
        subject_email       TEXT        NOT NULL,

        -- What they asked for
        request_type        TEXT        NOT NULL
                            CHECK (request_type IN (
                              'access', 'erasure', 'rectification',
                              'portability', 'restriction', 'objection'
                            )),

        -- SLA clock
        received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        due_at              TIMESTAMPTZ NOT NULL,

        -- Lifecycle
        status              TEXT        NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'in_progress', 'resolved', 'extended', 'rejected')),

        -- Extension support (Art. 12(3) two-month extension)
        extension_reason    TEXT,

        -- Tiered alert flags — set by scheduler, never reset
        alert_7d_sent       BOOLEAN     NOT NULL DEFAULT FALSE,
        alert_3d_sent       BOOLEAN     NOT NULL DEFAULT FALSE,
        alert_1d_sent       BOOLEAN     NOT NULL DEFAULT FALSE,

        -- Resolution audit trail (Art. 5(2))
        resolved_at         TIMESTAMPTZ,
        resolved_by         TEXT,
        resolution_reason   TEXT,
        resolution_evidence TEXT,

        -- Metadata
        notes               TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Scheduler hot path: open/in-progress rows ordered by due date
    await client.query(`
      CREATE INDEX idx_dsr_sla_open_due_at
        ON dsr_sla (due_at ASC)
        WHERE status IN ('open', 'in_progress', 'extended')
    `);

    // Compliance review: all requests for a given subject
    await client.query(`
      CREATE INDEX idx_dsr_sla_subject_id
        ON dsr_sla (subject_id)
    `);

    // Status filter for dashboard pagination
    await client.query(`
      CREATE INDEX idx_dsr_sla_status
        ON dsr_sla (status, received_at DESC)
    `);

    // Auto-update updated_at on any row change
    await client.query(`
      CREATE OR REPLACE FUNCTION dsr_sla_set_updated_at()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$
    `);

    await client.query(`
      CREATE TRIGGER dsr_sla_updated_at_trigger
        BEFORE UPDATE ON dsr_sla
        FOR EACH ROW EXECUTE FUNCTION dsr_sla_set_updated_at()
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TRIGGER IF EXISTS dsr_sla_updated_at_trigger ON dsr_sla`);
    await client.query(`DROP FUNCTION IF EXISTS dsr_sla_set_updated_at()`);
    await client.query(`DROP TABLE IF EXISTS dsr_sla`);
  },
};
