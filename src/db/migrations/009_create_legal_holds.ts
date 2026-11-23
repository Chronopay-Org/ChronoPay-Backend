import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "011",
  name: "create_legal_holds",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS legal_holds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_id VARCHAR(255) NOT NULL,
        actor VARCHAR(255) NOT NULL,
        reason TEXT NOT NULL,
        region VARCHAR(50) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_legal_holds_subject_id ON legal_holds(subject_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS legal_holds`);
  },
};
