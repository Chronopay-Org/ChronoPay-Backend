import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 008 — add_marketplace_search_fields
 *
 * Adds category, price_cents, and supplier_rating columns to slots table
 * to support marketplace search with filtering and ranking.
 *
 * Design decisions:
 *  - `category` VARCHAR(100) for service categorization (e.g., "haircut", "plumbing")
 *  - `price_cents` INTEGER storing amount in cents to avoid floating-point precision issues
 *  - `supplier_rating` NUMERIC(3,2) for 0-5 star ratings with 2 decimals (e.g., 4.50)
 *  - All columns NOT NULL with reasonable defaults
 *  - Indexes on category and supplier_rating for efficient filtering/sorting
 *  - Combined index (category, supplier_rating DESC, id) for deterministic pagination
 */
export const migration: Migration = {
  id: "008",
  name: "add_marketplace_search_fields",

  async up(client: PoolClient): Promise<void> {
    // Add new columns with default values
    await client.query(`
      ALTER TABLE slots
      ADD COLUMN category VARCHAR(100) NOT NULL DEFAULT 'general',
      ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN supplier_rating NUMERIC(3,2) NOT NULL DEFAULT 0.00
    `);

    // Add constraint for price_cents to be non-negative
    await client.query(`
      ALTER TABLE slots
      ADD CONSTRAINT chk_slots_price_non_negative CHECK (price_cents >= 0)
    `);

    // Add constraint for supplier_rating to be in valid range [0, 5]
    await client.query(`
      ALTER TABLE slots
      ADD CONSTRAINT chk_slots_rating_valid CHECK (supplier_rating >= 0 AND supplier_rating <= 5)
    `);

    // Create indexes for efficient search filtering and sorting
    await client.query(`
      CREATE INDEX idx_slots_category ON slots (category)
    `);

    await client.query(`
      CREATE INDEX idx_slots_supplier_rating ON slots (supplier_rating DESC)
    `);

    // Composite index for deterministic pagination with ranking
    await client.query(`
      CREATE INDEX idx_slots_search_ranking ON slots (category, supplier_rating DESC, id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP INDEX IF EXISTS idx_slots_search_ranking`);
    await client.query(`DROP INDEX IF EXISTS idx_slots_supplier_rating`);
    await client.query(`DROP INDEX IF EXISTS idx_slots_category`);
    await client.query(`
      ALTER TABLE slots
      DROP CONSTRAINT IF EXISTS chk_slots_rating_valid,
      DROP CONSTRAINT IF EXISTS chk_slots_price_non_negative,
      DROP COLUMN IF EXISTS supplier_rating,
      DROP COLUMN IF EXISTS price_cents,
      DROP COLUMN IF EXISTS category
    `);
  },
};
