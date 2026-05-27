import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 003 — add_slot_conflict_exclusion
 *
 * Adds a PostgreSQL EXCLUSION constraint on the `slots` table that prevents
 * two slots for the same professional from having overlapping time ranges.
 *
 * Design decisions:
 *  - Uses the `btree_gist` extension to allow mixing a regular equality
 *    column (professional_id) with a range operator (&&) in one constraint.
 *  - `tstzrange(start_time, end_time)` models the slot as a half-open interval
 *    [start, end), so adjacent slots (end of one == start of next) are allowed.
 *  - The constraint fires at statement time (DEFERRABLE INITIALLY IMMEDIATE),
 *    which is the safest default and prevents concurrent inserts from racing
 *    past the check.
 *  - The service layer also checks for conflicts before inserting, providing
 *    a fast-path 409 response without a DB round-trip on the happy path.
 *    The DB constraint is the authoritative last line of defence under
 *    concurrent requests.
 */
export const migration: Migration = {
  id: "003",
  name: "add_slot_conflict_exclusion",

  async up(client: PoolClient): Promise<void> {
    // btree_gist is required to mix equality (=) and range (&&) operators
    // in a single EXCLUDE constraint.
    await client.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    await client.query(`
      ALTER TABLE slots
        ADD CONSTRAINT excl_slots_no_overlap
        EXCLUDE USING gist (
          professional_id WITH =,
          tstzrange(start_time, end_time) WITH &&
        )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE slots DROP CONSTRAINT IF EXISTS excl_slots_no_overlap
    `);
    // We intentionally do NOT drop btree_gist — other constraints may rely on it.
  },
};
