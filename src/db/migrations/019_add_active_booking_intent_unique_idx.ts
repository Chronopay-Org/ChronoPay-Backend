import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 019 — add_active_booking_intent_unique_idx
 *
 * Adds a partial unique index on booking_intents(slot_id) covering only
 * active intents, i.e. those with status 'pending' or 'hold_placed'.
 *
 * Why a partial index instead of a full UNIQUE constraint:
 *  - The existing UNIQUE constraint on slot_id (added in 004) would block a
 *    new intent after a prior one is cancelled or completed, which is wrong.
 *  - A partial index scoped to active statuses means at most one in-flight
 *    intent per slot at any time, while allowing new intents once the
 *    previous one reaches a terminal state (cancelled / expired / confirmed).
 *
 * The application layer still does an optimistic check before inserting, but
 * that check has a race window under concurrent requests.  This index is the
 * authoritative last line of defence — any race loser receives a Postgres
 * unique_violation (23505) which the repository maps to a 409 Conflict.
 *
 * Note: migration 004 added a plain UNIQUE constraint on slot_id.  We drop
 * that here because it is strictly more restrictive than this partial index
 * and would reject valid creates for slots whose previous intent is done.
 */
export const migration: Migration = {
  id: "019",
  name: "add_active_booking_intent_unique_idx",

  async up(client: PoolClient): Promise<void> {
    // Drop the overly-broad full unique constraint added in migration 004.
    await client.query(`
      ALTER TABLE booking_intents
        DROP CONSTRAINT IF EXISTS booking_intents_slot_id_key
    `);

    // Partial unique index: only one active intent per slot at a time.
    await client.query(`
      CREATE UNIQUE INDEX idx_booking_intents_one_active_per_slot
        ON booking_intents (slot_id)
        WHERE status IN ('pending', 'hold_placed')
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS idx_booking_intents_one_active_per_slot
    `);

    // Restore the original constraint so a rollback leaves the schema as it was.
    await client.query(`
      ALTER TABLE booking_intents
        ADD CONSTRAINT booking_intents_slot_id_key UNIQUE (slot_id)
    `);
  },
};
