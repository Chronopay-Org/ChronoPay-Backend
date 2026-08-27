import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 016 — add_grace_window_config
 *
 * Introduces two new tables and one new column to support per-category
 * no-show grace-window configuration:
 *
 *   slot_category_grace_windows
 *     Stores the *current* effective grace window (in seconds) per slot
 *     category.  One row per category, updated in-place on each admin
 *     override.  The `UNIQUE (category)` constraint ensures a single
 *     source of truth per category.
 *
 *   slot_category_grace_window_history
 *     Append-only audit log of every grace-window change.  Rows are
 *     never updated or deleted — they form the immutable policy-change
 *     trail required by the spec.
 *
 *   slots.category (TEXT nullable)
 *     Links an individual slot to a slot category so that the
 *     scheduling service can look up the correct grace window at
 *     reservation time.  Nullable so existing slots remain valid
 *     without a backfill (they fall through to the default).
 *
 * Design decisions:
 *  - grace_window_seconds is INTEGER (not BIGINT / FLOAT) — seconds are
 *    the authoritative unit per the requirement spec.
 *  - CHECK constraint (grace_window_seconds >= 1) prevents a zero or
 *    negative value from being persisted even if application validation
 *    is somehow bypassed.
 *  - History rows reference slots.category (text) rather than using an
 *    FK so that category names can be deleted from the config table
 *    without cascading into the history log.
 *  - down() reverses in exact dependency order.
 */
export const migration: Migration = {
  id: "016",
  name: "add_grace_window_config",

  async up(client: PoolClient): Promise<void> {
    // 1. Current effective config per category.
    await client.query(`
      CREATE TABLE slot_category_grace_windows (
        id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        category             TEXT        NOT NULL,
        grace_window_seconds INTEGER     NOT NULL,
        updated_by           TEXT        NOT NULL,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_grace_windows_category     UNIQUE (category),
        CONSTRAINT chk_grace_window_positive     CHECK (grace_window_seconds >= 1),
        CONSTRAINT chk_grace_window_max          CHECK (grace_window_seconds <= 86400),
        CONSTRAINT chk_grace_window_category_len CHECK (char_length(category) <= 100)
      )
    `);

    await client.query(`
      CREATE INDEX idx_grace_windows_category
        ON slot_category_grace_windows (category)
    `);

    // 2. Immutable history table.
    await client.query(`
      CREATE TABLE slot_category_grace_window_history (
        id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        category                      TEXT        NOT NULL,
        previous_grace_window_seconds INTEGER,
        new_grace_window_seconds      INTEGER     NOT NULL,
        changed_by                    TEXT        NOT NULL,
        changed_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reason                        TEXT,
        CONSTRAINT chk_history_new_gw_positive     CHECK (new_grace_window_seconds >= 1),
        CONSTRAINT chk_history_new_gw_max          CHECK (new_grace_window_seconds <= 86400),
        CONSTRAINT chk_history_prev_gw_positive    CHECK (previous_grace_window_seconds IS NULL OR previous_grace_window_seconds >= 1),
        CONSTRAINT chk_history_category_len        CHECK (char_length(category) <= 100),
        CONSTRAINT chk_history_reason_len          CHECK (reason IS NULL OR char_length(reason) <= 500)
      )
    `);

    await client.query(`
      CREATE INDEX idx_grace_window_history_category
        ON slot_category_grace_window_history (category)
    `);

    await client.query(`
      CREATE INDEX idx_grace_window_history_changed_at
        ON slot_category_grace_window_history (changed_at DESC)
    `);

    // 3. Add nullable category column to the slots table (idempotent —
    //    column may already exist from an earlier migration).
    await client.query(`
      ALTER TABLE slots
        ADD COLUMN IF NOT EXISTS category TEXT
    `);

    // Only add the constraint if it doesn't already exist.
    const constraintExists = await client.query(`
      SELECT 1 FROM pg_constraint
      WHERE conname = 'chk_slots_category_len'
    `);
    if (constraintExists.rows.length === 0) {
      await client.query(`
        ALTER TABLE slots
          ADD CONSTRAINT chk_slots_category_len
          CHECK (category IS NULL OR char_length(category) <= 100)
      `);
    }

    // Only create the index if it doesn't already exist.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_slots_category
        ON slots (category)
        WHERE category IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Reverse in exact opposite order of up().

    // 3. Remove column from slots.
    await client.query(`DROP INDEX IF EXISTS idx_slots_category`);
    await client.query(`
      ALTER TABLE slots DROP CONSTRAINT IF EXISTS chk_slots_category_len
    `);
    await client.query(`ALTER TABLE slots DROP COLUMN IF EXISTS category`);

    // 2. Drop history table.
    await client.query(`DROP INDEX IF EXISTS idx_grace_window_history_changed_at`);
    await client.query(`DROP INDEX IF EXISTS idx_grace_window_history_category`);
    await client.query(`DROP TABLE IF EXISTS slot_category_grace_window_history`);

    // 1. Drop config table.
    await client.query(`DROP INDEX IF EXISTS idx_grace_windows_category`);
    await client.query(`DROP TABLE IF EXISTS slot_category_grace_windows`);
  },
};
