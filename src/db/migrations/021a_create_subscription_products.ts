import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 021a — create_subscription_products
 *
 * Defines the product catalogue for recurring slot subscriptions.
 * Each product describes a recurring schedule (e.g. "every Monday at 10am")
 * and the slot configuration that should be minted for each subscriber.
 */
export const migration: Migration = {
  id: "021a",
  name: "create_subscription_products",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_products (
        id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        name                VARCHAR(255) NOT NULL,
        description         TEXT,
        professional        TEXT         NOT NULL,
        slot_duration_ms    INTEGER      NOT NULL CHECK (slot_duration_ms > 0),
        recurrence_rule     TEXT         NOT NULL,
        timezone            TEXT         NOT NULL DEFAULT 'UTC',
        price_cents         INTEGER      NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
        currency            VARCHAR(3)   NOT NULL DEFAULT 'USD',
        max_subscribers     INTEGER      CHECK (max_subscribers IS NULL OR max_subscribers > 0),
        active              BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX idx_subscription_products_professional
        ON subscription_products (professional)
    `);

    await client.query(`
      CREATE INDEX idx_subscription_products_active
        ON subscription_products (active)
        WHERE active = TRUE
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS subscription_products`);
  },
};
