import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 040 — widen_reminders_slot_id
 *
 * `reminders.slot_id` was created as INTEGER (migration 006), but slots are
 * identified by UUID / `slot-<uuid>` strings, so reminders scheduled by
 * `BundleExpiryService` could not store the real slot id and the service
 * coerced it to a meaningless number. This migration:
 *
 *  - changes `slot_id` to TEXT (existing integer values are kept as their
 *    decimal text, e.g. 12 -> '12', so legacy reminders keep working), and
 *  - adds a non-unique composite index on (slot_id, trigger_at) backing the
 *    "does a reminder already exist for this slot and trigger time?" lookup.
 *
 * The index is deliberately not UNIQUE: earlier sweeps created duplicate
 * reminders, and adding a unique index would fail on those rows. Removing
 * them is a data decision, so it is left to a follow-up.
 *
 * `down` restores INTEGER, which cannot represent string ids. It refuses to
 * run (rather than deleting or mangling data) while any reminder has a
 * non-integer slot id.
 */
export const migration: Migration = {
  id: "040",
  name: "widen_reminders_slot_id",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE reminders
        ALTER COLUMN slot_id TYPE TEXT USING slot_id::text
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reminders_slot_id_trigger_at
        ON reminders (slot_id, trigger_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    const result = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM reminders
      WHERE slot_id !~ '^[0-9]{1,9}$'
    `);
    const blocking = Number(result.rows[0]?.count ?? 0);
    if (blocking > 0) {
      throw new Error(
        `Cannot roll back migration 040: ${blocking} reminder(s) have a slot_id that is not an integer. ` +
          "Delete or migrate them before rolling back.",
      );
    }

    await client.query(`DROP INDEX IF EXISTS idx_reminders_slot_id_trigger_at`);
    await client.query(`
      ALTER TABLE reminders
        ALTER COLUMN slot_id TYPE INTEGER USING slot_id::integer
    `);
  },
};
