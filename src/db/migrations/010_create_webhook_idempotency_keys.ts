import { Pool } from "pg";

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_idempotency_keys (
      tenant_id VARCHAR(255) NOT NULL,
      idempotency_key VARCHAR(255) NOT NULL,
      response_body JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      PRIMARY KEY (tenant_id, idempotency_key)
    );
    CREATE INDEX idx_webhook_idempotency_keys_expires_at ON webhook_idempotency_keys(expires_at);
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS webhook_idempotency_keys;`);
}
