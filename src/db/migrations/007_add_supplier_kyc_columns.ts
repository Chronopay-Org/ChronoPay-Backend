import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "007",
  name: "add_supplier_kyc_columns",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TYPE kyc_status_type AS ENUM ('pending', 'verified', 'rejected', 'under_review')
    `);
    await client.query(`
      ALTER TABLE users
      ADD COLUMN kyc_status kyc_status_type NOT NULL DEFAULT 'pending',
      ADD COLUMN kyc_ref VARCHAR(255)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE users
      DROP COLUMN IF EXISTS kyc_status,
      DROP COLUMN IF EXISTS kyc_ref
    `);
    await client.query(`
      DROP TYPE IF EXISTS kyc_status_type
    `);
  },
};
