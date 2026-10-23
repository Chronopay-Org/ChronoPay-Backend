import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "037",
  name: "add_outbox_claim_lease",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE outbox_events
        ADD COLUMN claimed_until TIMESTAMPTZ
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE outbox_events
        DROP COLUMN IF EXISTS claimed_until
    `);
  },
};
