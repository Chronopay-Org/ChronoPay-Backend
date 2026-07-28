import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "013",
  name: "create_partner_token_delivery_ledger",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE partner_token_soft_limit_config (
        partner_id    TEXT        PRIMARY KEY,
        soft_limit    REAL        NOT NULL DEFAULT 0.80,
        webhook_url   TEXT        NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE partner_token_delivery_ledger (
        id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id     TEXT        NOT NULL,
        token_usage    REAL        NOT NULL,
        soft_limit     REAL        NOT NULL,
        threshold_pct  REAL        NOT NULL,
        webhook_url    TEXT        NOT NULL,
        status         TEXT        NOT NULL DEFAULT 'pending',
        acked_at       TIMESTAMPTZ,
        dedupe_key     TEXT        NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX idx_partner_token_delivery_dedupe
        ON partner_token_delivery_ledger (dedupe_key)
    `);

    await client.query(`
      CREATE INDEX idx_partner_token_delivery_pending
        ON partner_token_delivery_ledger (status, created_at)
        WHERE status = 'pending'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS partner_token_delivery_ledger`);
    await client.query(`DROP TABLE IF EXISTS partner_token_soft_limit_config`);
  },
};
