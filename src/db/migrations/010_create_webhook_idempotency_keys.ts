import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "010",
  name: "create_webhook_idempotency_keys",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_idempotency_keys (
        tenant_id VARCHAR(255) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        response_body JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        PRIMARY KEY (tenant_id, idempotency_key)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_keys_expires_at
      ON webhook_idempotency_keys(expires_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS webhook_idempotency_keys`);
  },
};
