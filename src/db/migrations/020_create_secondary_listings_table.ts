import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 020 — create_secondary_listings_table
 *
 * Stores a resale listing for a slot that has already been sold to a buyer.
 * Rules enforced by the app and database:
 * - listing owner must match the current slot owner
 * - price floor must be positive
 * - expires_at must be in the future
 * - supplierConsent must be true before a secondary listing is accepted
 */
export const migration: Migration = {
  id: "020",
  name: "create_secondary_listings_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TYPE secondary_listing_state AS ENUM ('active', 'expired', 'cancelled', 'sold')
    `);

    await client.query(`
      CREATE TABLE secondary_listings (
        id TEXT PRIMARY KEY,
        slot_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        price_floor_cents BIGINT NOT NULL CHECK (price_floor_cents > 0),
        expires_at BIGINT NOT NULL CHECK (expires_at > 0),
        supplier_consent BOOLEAN NOT NULL DEFAULT false,
        state secondary_listing_state NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX idx_secondary_listings_active_expiry
        ON secondary_listings (state, expires_at)
        WHERE state = 'active'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS secondary_listings
    `);

    await client.query(`
      DROP TYPE IF EXISTS secondary_listing_state
    `);
  },
};
