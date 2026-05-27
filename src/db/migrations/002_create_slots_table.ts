import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 002 — create_slots_table
 *
 * Creates the `slots` table and the `slot_status` enum type.
 *
 * Design decisions:
 *  - `slot_status` as a PostgreSQL ENUM keeps status values at the DB level,
 *    preventing out-of-range values even if application validation is bypassed.
 *  - `professional_id` references users(id) ON DELETE CASCADE so orphaned slots
 *    are removed automatically when the owning user is deleted.
 *  - CHECK constraint (end_time > start_time) is the last line of defense
 *    against logically invalid time windows.
 *  - Down migration drops in reverse dependency order (table → type).
 */
export const migration: Migration = {
  id: "002",
  name: "create_slots_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TYPE slot_status AS ENUM ('available', 'booked', 'cancelled')
    `);

    await client.query(`
      CREATE TABLE slots (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        professional_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        start_time      TIMESTAMPTZ NOT NULL,
        end_time        TIMESTAMPTZ NOT NULL,
        status          slot_status NOT NULL DEFAULT 'available',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_slots_time_order CHECK (end_time > start_time)
      )
    `);

    await client.query(`
      CREATE INDEX idx_slots_professional_id ON slots (professional_id)
    `);

    await client.query(`
      CREATE INDEX idx_slots_start_time ON slots (start_time)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Drop table before the type it depends on.
    await client.query(`DROP TABLE IF EXISTS slots`);
    await client.query(`DROP TYPE IF EXISTS slot_status`);
  },
};
