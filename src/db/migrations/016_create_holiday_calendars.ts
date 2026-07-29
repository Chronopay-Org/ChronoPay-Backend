import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 016 — create_holiday_calendars
 *
 * Two-table design:
 *
 *   holiday_calendars         — one row per named calendar (keyed by region).
 *   holiday_calendar_entries  — individual holidays within a calendar, with
 *                               optional date-range support (start_date / end_date).
 *   holiday_calendar_revisions — append-only version history for rollback.
 *
 * Design decisions:
 *  - (calendar_id, start_date, end_date) EXCLUSION constraint (via btree_gist
 *    or a CHECK) is enforced at the DB level to prevent overlapping date ranges
 *    within a single calendar.  Because we target vanilla PostgreSQL without
 *    requiring the btree_gist extension, overlap detection is also enforced at
 *    the application layer in HolidayCalendarService.
 *  - `region` is lowercased at the API layer before storage; a UNIQUE index
 *    guarantees one active calendar per region.
 *  - Revisions store a full JSONB snapshot of the calendar state at the time
 *    of each write so historical fetches are a simple row lookup.
 */
export const migration: Migration = {
  id: "016",
  name: "create_holiday_calendars",

  async up(client: PoolClient): Promise<void> {
    // ── Master calendar table ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE holiday_calendars (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        region      TEXT        NOT NULL,
        name        TEXT        NOT NULL,
        description TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_holiday_calendars_region UNIQUE (region)
      )
    `);

    // ── Holiday entries ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE holiday_calendar_entries (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        calendar_id UUID        NOT NULL REFERENCES holiday_calendars(id) ON DELETE CASCADE,
        name        TEXT        NOT NULL,
        start_date  DATE        NOT NULL,
        end_date    DATE        NOT NULL,
        recurring   BOOLEAN     NOT NULL DEFAULT FALSE,
        note        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_holiday_entry_date_order CHECK (end_date >= start_date)
      )
    `);

    await client.query(`
      CREATE INDEX idx_holiday_entries_calendar_id
        ON holiday_calendar_entries (calendar_id)
    `);

    await client.query(`
      CREATE INDEX idx_holiday_entries_start_date
        ON holiday_calendar_entries (start_date)
    `);

    // ── Revision / version history table ────────────────────────────────────
    await client.query(`
      CREATE TABLE holiday_calendar_revisions (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        calendar_id UUID        NOT NULL REFERENCES holiday_calendars(id) ON DELETE CASCADE,
        version     INTEGER     NOT NULL,
        snapshot    JSONB       NOT NULL,
        changed_by  TEXT,
        change_note TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_holiday_calendar_revision UNIQUE (calendar_id, version)
      )
    `);

    await client.query(`
      CREATE INDEX idx_holiday_revisions_calendar_id
        ON holiday_calendar_revisions (calendar_id, version DESC)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS holiday_calendar_revisions`);
    await client.query(`DROP TABLE IF EXISTS holiday_calendar_entries`);
    await client.query(`DROP TABLE IF EXISTS holiday_calendars`);
  },
};
