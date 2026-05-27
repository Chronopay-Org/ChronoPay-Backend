import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 005 — add_token_references_to_booking_intents
 *
 * Adds `token_asset` and `mint_tx_hash` columns to the `booking_intents` table.
 * These columns store the reference to the minted time-token on Stellar.
 */
export const migration: Migration = {
  id: "005",
  name: "add_token_references_to_booking_intents",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE booking_intents
      ADD COLUMN token_asset TEXT,
      ADD COLUMN mint_tx_hash TEXT
    `);

    await client.query(`
      CREATE INDEX idx_booking_intents_token_asset ON booking_intents (token_asset)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE booking_intents
      DROP COLUMN IF EXISTS token_asset,
      DROP COLUMN IF EXISTS mint_tx_hash
    `);
  },
};
