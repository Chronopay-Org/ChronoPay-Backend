import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "021",
  name: "add_multi_currency_pricing",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE slots 
      ADD COLUMN currency VARCHAR(3),
      ADD COLUMN amount_minor BIGINT;
    `);

    await client.query(`
      ALTER TABLE booking_intents
      ADD COLUMN fx_rate_snapshot JSONB;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE booking_intents DROP COLUMN fx_rate_snapshot;
    `);
    await client.query(`
      ALTER TABLE slots DROP COLUMN amount_minor, DROP COLUMN currency;
    `);
  },
};
