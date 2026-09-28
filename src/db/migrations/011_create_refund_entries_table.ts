import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "011c",
  name: "create_refund_entries_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TYPE refund_entry_status AS ENUM (
        'pending', 'completed', 'failed'
      )
    `);

    await client.query(`
      CREATE TABLE refund_entries (
        id              UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id      UUID                     NOT NULL REFERENCES checkout_sessions(id) ON DELETE CASCADE,
        amount_cents    INTEGER                  NOT NULL CHECK (amount_cents > 0),
        currency        VARCHAR(10)              NOT NULL DEFAULT 'USD',
        reason          TEXT,
        status          refund_entry_status      NOT NULL DEFAULT 'completed',
        refunded_by     UUID                     REFERENCES users(id),
        created_at      TIMESTAMPTZ              NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX idx_refund_entries_payment_id ON refund_entries (payment_id)
    `);

    await client.query(`
      CREATE INDEX idx_refund_entries_created_at ON refund_entries (created_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS refund_entries`);
    await client.query(`DROP TYPE IF EXISTS refund_entry_status`);
  },
};
