import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 017 — add_residency_waivers_table
 *
 * Creates the residency waivers table used by the cross-region egress guard.
 *
 * Design decisions:
 *  - `target_region` identifies the region that data is allowed to egress to.
 *  - `scope` defines the scope of the waiver (e.g. "apiKey:<id>", "userId:<id>",
 *    "partner:<id>", or "*" for global).  The guard middleware checks whether
 *    the current request identity falls within any waiver's scope.
 *  - `expires_at` enforces temporal validity at the database level; the guard
 *    middleware filters to waivers WHERE expires_at > NOW() at query time.
 *  - `created_by` is informational (admin identity that granted the waiver).
 *  - The index on (scope, target_region) is the primary lookup path used by
 *    the guard middleware on every cross-region request.
 */
export const migration: Migration = {
  id: "017",
  name: "add_residency_waivers_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE residency_waivers (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        target_region TEXT        NOT NULL,
        scope         TEXT        NOT NULL,
        expires_at    TIMESTAMPTZ NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by    TEXT        NOT NULL DEFAULT 'system'
      )
    `);

    // Primary lookup: find active waivers by scope and target region.
    await client.query(`
      CREATE INDEX idx_residency_waivers_lookup
        ON residency_waivers (scope, target_region)
        WHERE expires_at > NOW()
    `);

    // Administrative listing: find waivers by target region regardless of expiry.
    await client.query(`
      CREATE INDEX idx_residency_waivers_region
        ON residency_waivers (target_region, expires_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS residency_waivers`);
  },
};
