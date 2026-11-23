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
 *   slots.category
 *     Already provided by migration 009 (add_marketplace_search_fields)
 *     as VARCHAR(100) NOT NULL DEFAULT 'general', so this migration must
 *     not re-add it.  The scheduling service reads that column to look
 *     up the correct grace window at reservation time; categories
 *     without a row in slot_category_grace_windows fall through to the
 *     default window.
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
  id: "022",
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

    // NOTE: slots.category and idx_slots_category already exist — migration
    // 009 (add_marketplace_search_fields) created them.  Re-adding them here
    // would make `migrate up` fail with "column \"category\" of relation
    // \"slots\" already exists".
  },

  async down(client: PoolClient): Promise<void> {
    // Reverse in exact opposite order of up().
    // (slots.category / idx_slots_category belong to migration 009 and are
    // deliberately NOT dropped here.)

    // 2. Drop history table.
    await client.query(`DROP INDEX IF EXISTS idx_grace_window_history_changed_at`);
    await client.query(`DROP INDEX IF EXISTS idx_grace_window_history_category`);
    await client.query(`DROP TABLE IF EXISTS slot_category_grace_window_history`);

    // 1. Drop config table.
    await client.query(`DROP INDEX IF EXISTS idx_grace_windows_category`);
    await client.query(`DROP TABLE IF EXISTS slot_category_grace_windows`);
  },
};
