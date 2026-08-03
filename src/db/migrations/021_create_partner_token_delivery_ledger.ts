import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 021 — partner token soft-limit config + delivery ledger.
 *
 * Stores per-partner soft-limit webhook configuration and an at-least-once
 * delivery ledger with dedupe keys so warning webhooks fire before hard cutoff.
 */
export const migration: Migration = {
  id: "021",
  name: "create_partner_token_delivery_ledger",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS partner_token_soft_limit_config (
        partner_id    TEXT        PRIMARY KEY,
        soft_limit    REAL        NOT NULL DEFAULT 0.80,
        webhook_url   TEXT        NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT partner_token_soft_limit_range
          CHECK (soft_limit > 0 AND soft_limit <= 1)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS partner_token_delivery_ledger (
        id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        partner_id     TEXT        NOT NULL,
        token_usage    REAL        NOT NULL,
        soft_limit     REAL        NOT NULL,
        threshold_pct  REAL        NOT NULL,
        webhook_url    TEXT        NOT NULL,
        status         TEXT        NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'delivered', 'acked', 'failed')),
        attempt_count  INTEGER     NOT NULL DEFAULT 0,
        last_error     TEXT,
        acked_at       TIMESTAMPTZ,
        dedupe_key     TEXT        NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_token_delivery_dedupe
        ON partner_token_delivery_ledger (dedupe_key)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_partner_token_delivery_retryable
        ON partner_token_delivery_ledger (status, created_at)
        WHERE status IN ('pending', 'failed')
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS partner_token_delivery_ledger`);
    await client.query(`DROP TABLE IF EXISTS partner_token_soft_limit_config`);
  },
};
