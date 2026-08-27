import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 013 — create_cancellation_reversal_ledger
 *
 * Persists the hash-chained ledger of prorated-cancellation reversals
 * introduced for issue #489.
 *
 * ## Column rationale
 *
 *  - `idempotency_key` UNIQUE: the database is the authority for the
 *    "no duplicate reversals for the same cancellation request" rule.
 *  - `booking_intent_id` NOT NULL: required for the per-booking invariant
 *    check (sum of reversals == -(netRefund)).
 *  - `payment_id` NOT NULL: linkage back to the originating checkout session.
 *  - `currency` NOT NULL: enforces single-currency consistency at insertion
 *    time when paired with CHECK constraint on amountCents sign-aware bounds.
 *  - `amount_cents` is a SIGNED integer. Negative = partial reversal
 *    (we returned less than the full original refund), positive =
 *    a correction that returned more than the full original refund.
 *  - `entry_hash` UNIQUE: SHA-256 chain hash; the database enforces
 *    no collisions and the application enforces hashed linkage.
 *  - `prev_hash` nullable only for the genesis row; partial unique index
 *    prevents a second genesis row.
 *  - `escrow_release_tx_id` used to bind the on-chain escrow release
 *    transaction; nullable because some reversals occur after escrow
 *    was already released externally or was never held.
 *  - `policy_version_id` records which cancellation policy authorised
 *    the reversal (grandfathering).
 */
export const migration: Migration = {
  id: "013b",
  name: "create_cancellation_reversal_ledger",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE cancellation_reversal_entries (
        id                          UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_intent_id           UUID           NOT NULL REFERENCES booking_intents(id) ON DELETE CASCADE,
        payment_id                  UUID           NOT NULL REFERENCES checkout_sessions(id) ON DELETE CASCADE,
        original_refund_id          UUID           REFERENCES refund_entries(id) ON DELETE SET NULL,
        amount_cents                BIGINT         NOT NULL CHECK (amount_cents <> 0),
        currency                    VARCHAR(10)    NOT NULL CHECK (currency IN ('USD','EUR','GBP','XLM')),
        escrow_released             BOOLEAN        NOT NULL DEFAULT FALSE,
        escrow_released_amount_cents BIGINT        NOT NULL DEFAULT 0 CHECK (escrow_released_amount_cents >= 0),
        escrow_release_tx_id         TEXT,
        reason                      TEXT           NOT NULL,
        idempotency_key             TEXT           NOT NULL UNIQUE,
        policy_version_id           TEXT           NOT NULL,
        actor                       TEXT           NOT NULL,
        metadata                    JSONB,
        entry_hash                  TEXT           NOT NULL UNIQUE,
        prev_hash                   TEXT,
        created_at                  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      )
    `);

    // Only one genesis row allowed (prev_hash IS NULL).
    await client.query(`
      CREATE UNIQUE INDEX idx_cancellation_reversal_genesis
        ON cancellation_reversal_entries ((prev_hash IS NULL))
        WHERE prev_hash IS NULL
    `);

    // Fast chain-walk.
    await client.query(`
      CREATE INDEX idx_cancellation_reversal_prev_hash
        ON cancellation_reversal_entries (prev_hash)
    `);

    // Ordered chain traversal.
    await client.query(`
      CREATE INDEX idx_cancellation_reversal_created_at
        ON cancellation_reversal_entries (created_at)
    `);

    // Per-payment lookup for the trace endpoint.
    await client.query(`
      CREATE INDEX idx_cancellation_reversal_payment_id
        ON cancellation_reversal_entries (payment_id)
    `);

    // Per-booking invariant check.
    await client.query(`
      CREATE INDEX idx_cancellation_reversal_booking_intent_id
        ON cancellation_reversal_entries (booking_intent_id)
    `);

    // Escrow chain linkage lookup.
    await client.query(`
      CREATE INDEX idx_cancellation_reversal_escrow_tx_id
        ON cancellation_reversal_entries (escrow_release_tx_id)
        WHERE escrow_release_tx_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS cancellation_reversal_entries`);
  },
};
