import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

const SHARED_TABLES = [
  "slots",
  "booking_intents",
  "reminders",
  "checkout_sessions",
  "webhook_idempotency_keys",
] as const;

export const migration: Migration = {
  id: "013",
  name: "enable_row_level_security",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id         TEXT        PRIMARY KEY,
        name       TEXT        NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const table of SHARED_TABLES) {
      await client.query(`
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS tenant_id TEXT
          NOT NULL DEFAULT 'default'
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_${table}_tenant_id
          ON ${table} (tenant_id)
      `);
    }

    for (const table of SHARED_TABLES) {
      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }

    for (const table of SHARED_TABLES) {
      await client.query(`
        CREATE POLICY ${table}_tenant_isolation ON ${table}
          FOR ALL
          USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::TEXT)
          WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::TEXT)
      `);

      await client.query(`
        CREATE POLICY ${table}_admin_bypass ON ${table}
          FOR ALL
          USING (nullif(current_setting('app.is_admin', true), '')::TEXT = 'true')
          WITH CHECK (true)
      `);
    }
  },

  async down(client: PoolClient): Promise<void> {
    for (const table of [...SHARED_TABLES].reverse()) {
      await client.query(`DROP POLICY IF EXISTS ${table}_admin_bypass ON ${table}`);
      await client.query(`DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table}`);
      await client.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      await client.query(`DROP INDEX IF EXISTS idx_${table}_tenant_id`);
      await client.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS tenant_id`);
    }

    await client.query(`DROP TABLE IF EXISTS tenants`);
  },
};