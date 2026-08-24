import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 021 — add_anomaly_score_to_booking_intents
 *
 * Persists the anomaly-detection output (issue #596) alongside every
 * booking intent so flagged intents remain reviewable after restarts.
 *
 * Design decisions:
 *  - `anomaly_score` REAL keeps the [0, 1] score with single-precision storage.
 *    NULL means "scoring did not run" (e.g. rows created before this feature),
 *    which is distinct from a legitimate 0 score ("scoring ran, nothing anomalous").
 *  - `anomaly_flagged` is materialized (not derived from the threshold at read
 *    time) so historical flags stay stable even if the threshold is retuned.
 *  - `anomaly_signals` JSONB stores the per-signal breakdown for reviewer UX.
 *  - A partial index on flagged rows keeps the admin anomaly queue fast while
 *    staying near-zero-cost for the overwhelmingly unflagged majority.
 */
export const migration: Migration = {
  id: "021",
  name: "add_anomaly_score_to_booking_intents",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE booking_intents
        ADD COLUMN IF NOT EXISTS anomaly_score REAL,
        ADD COLUMN IF NOT EXISTS anomaly_flagged BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS anomaly_signals JSONB
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_booking_intents_anomaly_flagged
        ON booking_intents (anomaly_flagged)
        WHERE anomaly_flagged
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS idx_booking_intents_anomaly_flagged
    `);
    await client.query(`
      ALTER TABLE booking_intents
        DROP COLUMN IF EXISTS anomaly_signals,
        DROP COLUMN IF EXISTS anomaly_flagged,
        DROP COLUMN IF EXISTS anomaly_score
    `);
  },
};
