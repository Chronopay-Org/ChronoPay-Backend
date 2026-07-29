import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 020 — create_gdpr_erasure_events
 *
 * Creates the `gdpr_erasure_events` table used as the erasure receipt log.
 *
 * ## Design decisions
 *
 * - `receipt_id` UUID is the canonical identifier for a single erasure run.
 * - `subject_id` is a plain text reference to `users.id`.  We deliberately
 *   avoid a FK to allow the event row to outlive the user record it describes
 *   (the whole point of erasure is removing the user row).
 * - `receipt` JSONB stores the full `ErasureReceipt` payload so auditors can
 *   retrieve the complete picture without joining other tables.
 * - `dry_run` BOOLEAN lets compliance queries quickly filter preview runs from
 *   live runs.
 * - `requested_by` records the admin actor UUID for access-audit purposes.
 * - `erased_at` is the application-level timestamp embedded in the receipt;
 *   `created_at` is the DB insertion time.
 */
export const migration: Migration = {
  id: "020",
  name: "create_gdpr_erasure_events",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS gdpr_erasure_events (
        id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        receipt_id   UUID        NOT NULL UNIQUE,
        subject_id   TEXT        NOT NULL,
        erased_at    TIMESTAMPTZ NOT NULL,
        receipt      JSONB       NOT NULL,
        dry_run      BOOLEAN     NOT NULL DEFAULT FALSE,
        requested_by TEXT        NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX idx_gdpr_erasure_events_subject_id
        ON gdpr_erasure_events (subject_id)
    `);

    await client.query(`
      CREATE INDEX idx_gdpr_erasure_events_erased_at
        ON gdpr_erasure_events (erased_at DESC)
    `);

    // Allow filtering dry-run vs. live erasures.
    await client.query(`
      CREATE INDEX idx_gdpr_erasure_events_dry_run
        ON gdpr_erasure_events (dry_run)
      WHERE dry_run = FALSE
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS gdpr_erasure_events`);
  },
};
