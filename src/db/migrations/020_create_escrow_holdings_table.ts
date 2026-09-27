import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 020 — create_escrow_holdings_table
 *
 * Creates the `escrow_holdings` table that tracks on-chain escrow funds held
 * by the ChronoPay Stellar smart contract on behalf of booking intents.
 *
 * Design decisions:
 *  - `escrow_holding_status` ENUM restricts lifecycle transitions to the four
 *    meaningful states emitted by the Stellar contract event stream:
 *      held      — funds are locked in escrow (Held event received)
 *      released  — funds returned to customer (Released event received)
 *      refunded  — customer refunded by supplier agreement (Refunded event)
 *      slashed   — supplier penalised; funds diverted (Slashed event)
 *  - `booking_intent_id` is nullable TEXT (not a FK) to keep this table
 *    independent of the booking_intents schema; an intent may not be known at
 *    insert time if the Held event arrives before the intent is created.
 *  - `slot_id` is similarly nullable TEXT — the fallback lookup key when no
 *    booking_intent_id is present in the contract event.
 *  - `amount` is NUMERIC(20, 7) to accommodate Stellar's 7-decimal-place
 *    stroops representation without floating-point rounding errors.
 *  - `currency` defaults to 'XLM' because ChronoPay's initial deployment only
 *    supports the native Stellar asset.
 *  - `contract_address` is the Stellar contract address (C + 55 base32 chars)
 *    that emitted the event; stored for allowlist verification on replay.
 *  - `stellar_tx_hash` is the 64-char hex transaction hash from the ledger.
 *  - `ledger_seq` is the ledger sequence number at the time the event was
 *    processed; used for cursor-based polling and replay ordering.
 *  - A unique index on (stellar_tx_hash, event_index) prevents double-insertion
 *    of the same on-chain event if the listener restarts and replays events.
 *  - Indexes on booking_intent_id, slot_id, and status support the common
 *    query patterns: lookup by intent, lookup by slot, filter by status.
 */
export const migration: Migration = {
  id: "020",
  name: "create_escrow_holdings_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TYPE escrow_holding_status AS ENUM (
        'held', 'released', 'refunded', 'slashed'
      )
    `);

    await client.query(`
      CREATE TABLE escrow_holdings (
        id                  UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_intent_id   TEXT,
        slot_id             TEXT,
        amount              NUMERIC(20, 7)         NOT NULL,
        currency            TEXT                  NOT NULL DEFAULT 'XLM',
        status              escrow_holding_status NOT NULL DEFAULT 'held',
        contract_address    TEXT                  NOT NULL,
        stellar_tx_hash     TEXT                  NOT NULL,
        event_index         INTEGER               NOT NULL DEFAULT 0,
        ledger_seq          INTEGER               NOT NULL,
        created_at          TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ           NOT NULL DEFAULT NOW()
      )
    `);

    // Idempotency guard: one row per on-chain event (tx + position).
    await client.query(`
      CREATE UNIQUE INDEX idx_escrow_holdings_tx_event
        ON escrow_holdings (stellar_tx_hash, event_index)
    `);

    // Lookup by booking intent (common read path for intent status checks).
    await client.query(`
      CREATE INDEX idx_escrow_holdings_booking_intent_id
        ON escrow_holdings (booking_intent_id)
        WHERE booking_intent_id IS NOT NULL
    `);

    // Lookup by slot (fallback when no booking_intent_id is available).
    await client.query(`
      CREATE INDEX idx_escrow_holdings_slot_id
        ON escrow_holdings (slot_id)
        WHERE slot_id IS NOT NULL
    `);

    // Filter by lifecycle status (dashboard queries, drain worker).
    await client.query(`
      CREATE INDEX idx_escrow_holdings_status
        ON escrow_holdings (status)
    `);

    // Ledger cursor: used by the event listener to resume polling.
    await client.query(`
      CREATE INDEX idx_escrow_holdings_ledger_seq
        ON escrow_holdings (ledger_seq)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS escrow_holdings`);
    await client.query(`DROP TYPE IF EXISTS escrow_holding_status`);
  },
};
