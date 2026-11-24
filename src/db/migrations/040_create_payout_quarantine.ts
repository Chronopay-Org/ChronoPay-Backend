import type { PoolClient } from "pg";
import type { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "040",
  name: "create_payout_quarantine",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS payout_quarantine (
        payout_id           TEXT        PRIMARY KEY,
        supplier_id         TEXT,
        total_failures      INTEGER     NOT NULL CHECK (total_failures >= 0),
        threshold           INTEGER     NOT NULL,
        status              TEXT        NOT NULL
          CHECK (status IN ('active', 'quarantined', 'released')),
        last_error_class    TEXT,
        last_error_message  TEXT,
        quarantined_at      TIMESTAMPTZ,
        released_at         TIMESTAMPTZ,
        quarantine_reason   TEXT,
        release_reason      TEXT,
        released_by         TEXT,
        quarantine_event_id UUID,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_payout_quarantine_status
        ON payout_quarantine (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS payout_quarantine`);
  },
};
