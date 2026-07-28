import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "018",
  name: "add_reputation_bootstrap_columns",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS region VARCHAR(64),
      ADD COLUMN IF NOT EXISTS reputation_bootstrap_granted BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reputation_bootstrap_granted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reputation_bootstrap_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reputation_bootstrap_consumed BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reputation_bootstrap_consumed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS reputation_bootstrap_score NUMERIC(5,2)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_bootstrap_expires_at
      ON users (reputation_bootstrap_expires_at)
      WHERE reputation_bootstrap_granted = TRUE AND reputation_bootstrap_consumed = FALSE
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS idx_users_bootstrap_expires_at
    `);

    await client.query(`
      ALTER TABLE users
      DROP COLUMN IF EXISTS reputation_bootstrap_score,
      DROP COLUMN IF EXISTS reputation_bootstrap_consumed_at,
      DROP COLUMN IF EXISTS reputation_bootstrap_consumed,
      DROP COLUMN IF EXISTS reputation_bootstrap_expires_at,
      DROP COLUMN IF EXISTS reputation_bootstrap_granted_at,
      DROP COLUMN IF EXISTS reputation_bootstrap_granted,
      DROP COLUMN IF EXISTS region
    `);
  },
};
