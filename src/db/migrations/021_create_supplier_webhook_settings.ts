import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 021 — create_supplier_webhook_settings
 *
 * Creates the tables backing outbound supplier webhooks, starting with
 * `slot.reservation.expired`:
 *  - supplier_webhook_endpoints: one delivery URL + signing secret per
 *    supplier. Deliberately single-endpoint-per-supplier; multi-endpoint
 *    fan-out is out of scope.
 *  - supplier_webhook_preferences: per-(supplier, event_type) opt-in/out,
 *    defaulting to enabled when no row exists (opt-out model — a new
 *    supplier-facing event is on by default; suppliers can turn it off).
 *  - webhook_delivery_attempts: tracks backoff state per outbox event so
 *    a failing endpoint is retried with exponential backoff rather than
 *    on every outbox relay sweep (default every 3s).
 */
export const migration: Migration = {
  id: "021",
  name: "create_supplier_webhook_settings",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE supplier_webhook_endpoints (
        supplier_id UUID        PRIMARY KEY,
        url         TEXT        NOT NULL,
        secret      TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE supplier_webhook_preferences (
        supplier_id UUID        NOT NULL,
        event_type  TEXT        NOT NULL,
        enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (supplier_id, event_type)
      )
    `);

    await client.query(`
      CREATE TABLE webhook_delivery_attempts (
        outbox_event_id UUID        PRIMARY KEY,
        attempt_count   INT         NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        last_error      TEXT,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS webhook_delivery_attempts`);
    await client.query(`DROP TABLE IF EXISTS supplier_webhook_preferences`);
    await client.query(`DROP TABLE IF EXISTS supplier_webhook_endpoints`);
  },
};