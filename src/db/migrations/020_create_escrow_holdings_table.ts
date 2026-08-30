import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 020 — create_escrow_holdings_table
 *
 * Stores a per-booking-intent escrow hold that is held until the slot end-time
 * plus a confirmation window has elapsed. The state machine is intentionally
 * narrow and explicit: held -> released | refunded | disputed.
 */
export const migration: Migration = {
  id: "020",
  name: "create_escrow_holdings_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TYPE escrow_hold_state AS ENUM ('held', 'released', 'refunded', 'disputed')
    `);

    await client.query(`
      CREATE TABLE escrow_holdings (
        id TEXT PRIMARY KEY,
        booking_intent_id TEXT NOT NULL UNIQUE,
        buyer_id TEXT NOT NULL,
        supplier_id TEXT NOT NULL,
        amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
        currency TEXT NOT NULL,
        state escrow_hold_state NOT NULL DEFAULT 'held',
        slot_end_time_ms BIGINT NOT NULL CHECK (slot_end_time_ms >= 0),
        confirmation_window_ms BIGINT NOT NULL CHECK (confirmation_window_ms >= 0),
        scheduled_release_at_ms BIGINT NOT NULL,
        last_reason TEXT,
        dispute_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at_ms BIGINT,
        audit_trail JSONB NOT NULL DEFAULT '[]'::jsonb
      )
    `);

    await client.query(`
      CREATE INDEX idx_escrow_holdings_release_due
        ON escrow_holdings (state, scheduled_release_at_ms)
        WHERE state = 'held'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS escrow_holdings
    `);

    await client.query(`
      DROP TYPE IF EXISTS escrow_hold_state
    `);
  },
};
