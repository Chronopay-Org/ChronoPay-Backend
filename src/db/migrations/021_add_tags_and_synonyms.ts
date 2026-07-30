import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "021",
  name: "add_tags_and_synonyms",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE slots
      ADD COLUMN tags VARCHAR(100)[] NOT NULL DEFAULT '{}'
    `);

    await client.query(`
      CREATE INDEX idx_slots_tags ON slots USING gin (tags)
    `);

    await client.query(`
      CREATE TABLE search_synonyms (
        id SERIAL PRIMARY KEY,
        word VARCHAR(100) UNIQUE NOT NULL,
        synonyms VARCHAR(100)[] NOT NULL
      )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS search_synonyms`);
    await client.query(`DROP INDEX IF EXISTS idx_slots_tags`);
    await client.query(`
      ALTER TABLE slots
      DROP COLUMN IF EXISTS tags
    `);
  },
};
