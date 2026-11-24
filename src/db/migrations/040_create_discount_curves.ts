import type { PoolClient } from "pg";
import type { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "040",
  name: "create_discount_curves",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS discount_curves (
        id            TEXT        PRIMARY KEY,
        name          VARCHAR(256) NOT NULL,
        description   TEXT,
        supplier_id   TEXT        NOT NULL,
        bundle_id     TEXT        NOT NULL,
        tiers         JSONB       NOT NULL,
        stackability  JSONB       NOT NULL,
        active        BOOLEAN     NOT NULL DEFAULT TRUE,
        valid_from    BIGINT,
        valid_until   BIGINT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (
          valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until
        )
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_discount_curves_supplier_bundle
        ON discount_curves (supplier_id, bundle_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_discount_curves_active
        ON discount_curves (active)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS discount_curves`);
  },
};
