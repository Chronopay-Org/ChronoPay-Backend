import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 011 — add_slot_valid_until
 *
 * Adds a nullable `valid_until` TIMESTAMPTZ column to the `slots` table.
 * When present the column models a bundle expiry window: individual slot
 * redemptions (booking-intent creation) must occur before this deadline.
 *
 * Design decisions:
 *  - Nullable so existing slots (without a bundle window) are unaffected.
 *  - CHECK constraint (valid_until > end_time) ensures the expiry window
 *    always extends beyond the slot's own time range.
 *  - Index on (valid_until) WHERE valid_until IS NOT NULL supports the
 *    common query "find slots expiring soon" used by the reminder worker.
 */
export const migration: Migration = {
  id: "011",
  name: "add_slot_valid_until",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE slots
        ADD COLUMN valid_until TIMESTAMPTZ
    `);

    await client.query(`
      ALTER TABLE slots
        ADD CONSTRAINT chk_slots_valid_until_after_end
        CHECK (valid_until IS NULL OR valid_until > end_time)
    `);

    await client.query(`
      CREATE INDEX idx_slots_valid_until
        ON slots (valid_until)
        WHERE valid_until IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP INDEX IF EXISTS idx_slots_valid_until`);
    await client.query(`
      ALTER TABLE slots DROP CONSTRAINT IF EXISTS chk_slots_valid_until_after_end
    `);
    await client.query(`ALTER TABLE slots DROP COLUMN IF EXISTS valid_until`);
  },
};
