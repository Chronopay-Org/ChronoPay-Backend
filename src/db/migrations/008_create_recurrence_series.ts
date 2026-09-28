import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 008 — create_recurrence_series
 *
 * Creates the recurrence_series and materialized_occurrences tables to support
 * RRULE occurrence pre-materialization with a rolling 90-day horizon.
 *
 * Design decisions:
 *  - `recurrence_series.version` is an INTEGER that is bumped on every RRULE edit.
 *    Materialized occurrences carry the version at materialization time, so stale
 *    rows can be filtered or cleaned up without a cascading DELETE.
 *  - `materialized_occurrences.occurrence_date` is TIMESTAMPTZ to preserve timezone
 *    context for DST-aware queries.
 *  - Composite index on (series_id, series_version DESC, occurrence_date) supports
 *    efficient "latest version only" scans.
 *  - Index on `occurrence_date` supports horizon cleanup queries.
 */
export const migration: Migration = {
  id: "008b",
  name: "create_recurrence_series",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE recurrence_series (
        id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        rrule       TEXT         NOT NULL,
        version     INTEGER      NOT NULL DEFAULT 1,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_recurrence_series_version_positive CHECK (version > 0)
      )
    `);

    await client.query(`
      CREATE TABLE materialized_occurrences (
        id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        series_id        UUID         NOT NULL REFERENCES recurrence_series(id) ON DELETE CASCADE,
        series_version   INTEGER      NOT NULL,
        occurrence_date  TIMESTAMPTZ  NOT NULL,
        materialized_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_materialized_occurrences_version_positive CHECK (series_version > 0)
      )
    `);

    // Efficient "latest version only" lookups for a series
    await client.query(`
      CREATE INDEX idx_materialized_occurrences_series_version
        ON materialized_occurrences (series_id, series_version DESC, occurrence_date)
    `);

    // Supports rolling-horizon cleanup (DELETE WHERE occurrence_date < cutoff)
    await client.query(`
      CREATE INDEX idx_materialized_occurrences_date
        ON materialized_occurrences (occurrence_date)
    `);

    // Supports cleaning stale versions
    await client.query(`
      CREATE INDEX idx_materialized_occurrences_series_version_cleanup
        ON materialized_occurrences (series_id, series_version)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS materialized_occurrences`);
    await client.query(`DROP TABLE IF EXISTS recurrence_series`);
  },
};
