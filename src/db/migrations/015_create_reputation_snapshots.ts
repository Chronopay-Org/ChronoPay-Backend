import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 015 — create_reputation_snapshots
 *
 * Daily frozen snapshots of supplier reputation scores for reproducible
 * historical charts. Key design properties:
 *
 *   - (supplier_id, snapshot_date) is UNIQUE — one snapshot per supplier per UTC day.
 *   - snapshot_date is a DATE (no time component) keyed to UTC midnight.
 *   - tier_label captures the tier boundary at snapshot time so charts can
 *     show where a supplier sat relative to thresholds even if thresholds change.
 *   - score and tier_boundaries are immutable once written.
 *   - job_run_id ties each snapshot row back to a specific scheduler run for
 *     idempotency checks and backfill tracing.
 */
export const migration: Migration = {
  id: "015",
  name: "create_reputation_snapshots",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE reputation_snapshots (
        id               UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
        supplier_id      TEXT  NOT NULL,
        snapshot_date    DATE  NOT NULL,
        score            NUMERIC(10, 4) NOT NULL,
        tier_label       TEXT  NOT NULL,
        tier_boundaries  JSONB NOT NULL,
        job_run_id       TEXT  NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // One snapshot per supplier per day — idempotent upsert key.
    await client.query(`
      CREATE UNIQUE INDEX idx_reputation_snapshots_supplier_date
        ON reputation_snapshots (supplier_id, snapshot_date)
    `);

    // Fast time-series range queries.
    await client.query(`
      CREATE INDEX idx_reputation_snapshots_date
        ON reputation_snapshots (snapshot_date DESC)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS reputation_snapshots`);
  },
};
