import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 006 — create_reminders_table
 *
 * Persists scheduled reminders and their delivery state so the reminder worker
 * can resume after restarts and track at-least-once delivery attempts.
 */
export const migration: Migration = {
  id: "006",
  name: "create_reminders_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TYPE reminder_status AS ENUM ('pending', 'sent', 'failed')
    `);

    await client.query(`
      CREATE TABLE reminders (
        id              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
        slot_id         INTEGER          NOT NULL,
        trigger_at      TIMESTAMPTZ      NOT NULL,
        status          reminder_status   NOT NULL DEFAULT 'pending',
        attempts        INTEGER          NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMPTZ,
        sent_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_reminders_attempts_non_negative CHECK (attempts >= 0)
      )
    `);

    await client.query(`
      CREATE INDEX idx_reminders_status_trigger_at ON reminders (status, trigger_at)
    `);

    await client.query(`
      CREATE INDEX idx_reminders_slot_id ON reminders (slot_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS reminders`);
    await client.query(`DROP TYPE IF EXISTS reminder_status`);
  },
};