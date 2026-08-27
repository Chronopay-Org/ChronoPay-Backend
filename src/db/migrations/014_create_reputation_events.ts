import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 014 — create_reputation_events
 *
 * Append-only audit log for every supplier reputation score mutation.
 * Every row captures:
 *   - supplier_id  : the affected supplier
 *   - actor_id     : the user or system that triggered the change
 *   - cause        : one of: dispute, review, no_show, decay_tick, manual_override
 *   - cause_id     : nullable FK-style reference to the source event (e.g. dispute id)
 *   - delta        : signed numeric score change (positive = improvement)
 *   - score_before : snapshot of score just before the change
 *   - score_after  : snapshot of score just after the change
 *   - metadata     : optional JSONB for extensibility
 *
 * Design decisions:
 *   - No UPDATE or DELETE allowed — enforced by application layer.
 *   - Immutable by convention: the table has no updated_at column.
 *   - Indexed on supplier_id + occurred_at to support time-range queries.
 *   - cause_id is nullable to allow system-generated causes without a source event.
 */
export const migration: Migration = {
  id: "014c",
  name: "create_reputation_events",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE reputation_events (
        id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        supplier_id  TEXT        NOT NULL,
        actor_id     TEXT        NOT NULL,
        cause        TEXT        NOT NULL,
        cause_id     TEXT,
        delta        NUMERIC(10, 4) NOT NULL,
        score_before NUMERIC(10, 4) NOT NULL,
        score_after  NUMERIC(10, 4) NOT NULL,
        metadata     JSONB,
        occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // CHECK constraint guards the allowed cause values at the DB level.
    await client.query(`
      ALTER TABLE reputation_events
        ADD CONSTRAINT chk_reputation_events_cause
          CHECK (cause IN ('dispute', 'review', 'no_show', 'decay_tick', 'manual_override'))
    `);

    // Primary access pattern: supplier history ordered by time.
    await client.query(`
      CREATE INDEX idx_reputation_events_supplier_time
        ON reputation_events (supplier_id, occurred_at DESC)
    `);

    // Useful for correlating a specific source event across suppliers.
    await client.query(`
      CREATE INDEX idx_reputation_events_cause_id
        ON reputation_events (cause_id)
        WHERE cause_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS reputation_events`);
  },
};
