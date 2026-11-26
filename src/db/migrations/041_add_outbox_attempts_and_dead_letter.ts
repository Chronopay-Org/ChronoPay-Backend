import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 041 — add_outbox_attempts_and_dead_letter
 *
 * Adds delivery-attempt tracking and dead-letter columns to `outbox_events`
 * so events that repeatedly fail webhook/consumer delivery are bounded by
 * a maximum attempt count and marked failed instead of retrying forever.
 */
export const migration: Migration = {
  id: "041",
  name: "add_outbox_attempts_and_dead_letter",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE outbox_events
        ADD COLUMN attempts   INTEGER     NOT NULL DEFAULT 0,
        ADD COLUMN failed_at  TIMESTAMPTZ,
        ADD COLUMN last_error TEXT
    `);

    await client.query(`
      CREATE INDEX idx_outbox_events_failed
        ON outbox_events (failed_at)
        WHERE failed_at IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP INDEX IF EXISTS idx_outbox_events_failed`);
    await client.query(`
      ALTER TABLE outbox_events
        DROP COLUMN IF EXISTS last_error,
        DROP COLUMN IF EXISTS failed_at,
        DROP COLUMN IF EXISTS attempts
    `);
  },
};
