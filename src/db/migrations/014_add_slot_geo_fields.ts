import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 014 — add_slot_geo_fields
 *
 * Adds optional geo centroid columns to the `slots` table to support
 * H3-indexed radius search (see marketplaceSearchService.ts / h3GeoIndex.ts).
 *
 * Design decisions:
 *  - `latitude` / `longitude` store the exact slot centroid, used for the
 *    precise great-circle distance calculation applied to the H3-prefiltered
 *    candidate set.
 *  - `h3_cell_res7` stores the precomputed H3 cell (resolution 7, ~1.4km
 *    edge length) for the centroid. Precomputing and storing this at write
 *    time (rather than computing it per-query) keeps the radius prefilter to
 *    a single indexed equality/ANY lookup.
 *  - All three columns are nullable: geo data is optional per slot (not
 *    every service is location-bound), so radius search simply excludes rows
 *    with no geo data via the partial index / IS NOT NULL predicate.
 *  - `chk_slots_geo_consistency` ensures the three columns are always either
 *    all NULL or all populated together, so the app layer can rely on
 *    `h3_cell_res7 IS NOT NULL` implying valid `latitude`/`longitude` are
 *    also present.
 *  - Range CHECK constraints enforce valid lat/lng bounds at the DB level as
 *    a last line of defense, independent of application-level validation.
 *  - The index on `h3_cell_res7` is partial (`WHERE h3_cell_res7 IS NOT
 *    NULL`) since most rows may not carry geo data; this keeps the index
 *    small and the radius-search ANY(...) lookup fast.
 */
export const migration: Migration = {
  id: "014",
  name: "add_slot_geo_fields",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE slots
      ADD COLUMN latitude NUMERIC(9,6),
      ADD COLUMN longitude NUMERIC(9,6),
      ADD COLUMN h3_cell_res7 VARCHAR(20)
    `);

    await client.query(`
      ALTER TABLE slots
      ADD CONSTRAINT chk_slots_latitude_valid
        CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90))
    `);

    await client.query(`
      ALTER TABLE slots
      ADD CONSTRAINT chk_slots_longitude_valid
        CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
    `);

    await client.query(`
      ALTER TABLE slots
      ADD CONSTRAINT chk_slots_geo_consistency
        CHECK (
          (latitude IS NULL AND longitude IS NULL AND h3_cell_res7 IS NULL)
          OR
          (latitude IS NOT NULL AND longitude IS NOT NULL AND h3_cell_res7 IS NOT NULL)
        )
    `);

    // Partial index: only slots with geo data are ever scanned by radius search.
    await client.query(`
      CREATE INDEX idx_slots_h3_cell_res7
      ON slots (h3_cell_res7)
      WHERE h3_cell_res7 IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP INDEX IF EXISTS idx_slots_h3_cell_res7`);
    await client.query(`
      ALTER TABLE slots
      DROP CONSTRAINT IF EXISTS chk_slots_geo_consistency,
      DROP CONSTRAINT IF EXISTS chk_slots_longitude_valid,
      DROP CONSTRAINT IF EXISTS chk_slots_latitude_valid,
      DROP COLUMN IF EXISTS h3_cell_res7,
      DROP COLUMN IF EXISTS longitude,
      DROP COLUMN IF EXISTS latitude
    `);
  },
};
