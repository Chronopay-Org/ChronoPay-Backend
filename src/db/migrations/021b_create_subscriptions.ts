import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 021b — create_subscriptions
 *
 * Tracks individual subscriber memberships against a subscription product.
 * The `next_slot_start_ms` column is the cursor used by the generator worker
 * to mint the next recurring slot. It is advanced atomically after each
 * successful mint, guaranteeing idempotency across restarts.
 */
export const migration: Migration = {
  id: "021b",
  name: "create_subscriptions",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TYPE subscription_status AS ENUM (
        'active',
        'paused',
        'cancelled'
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id                  UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id          UUID                 NOT NULL REFERENCES subscription_products(id) ON DELETE CASCADE,
        subscriber_id       TEXT                 NOT NULL,
        status              subscription_status  NOT NULL DEFAULT 'active',
        next_slot_start_ms  BIGINT               NOT NULL,
        slot_offset_ms      INTEGER              NOT NULL DEFAULT 0,
        slots_minted        INTEGER              NOT NULL DEFAULT 0,
        paused_at           TIMESTAMPTZ,
        cancelled_at        TIMESTAMPTZ,
        created_at          TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ          NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX idx_subscriptions_product_id
        ON subscriptions (product_id)
    `);

    await client.query(`
      CREATE INDEX idx_subscriptions_subscriber_id
        ON subscriptions (subscriber_id)
    `);

    await client.query(`
      CREATE INDEX idx_subscriptions_status_next_slot
        ON subscriptions (status, next_slot_start_ms)
        WHERE status = 'active'
    `);

    await client.query(`
      CREATE UNIQUE INDEX idx_subscriptions_active_per_product
        ON subscriptions (product_id, subscriber_id)
        WHERE status IN ('active', 'paused')
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS subscriptions`);
    await client.query(`DROP TYPE IF EXISTS subscription_status`);
  },
};
