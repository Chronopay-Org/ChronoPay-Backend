import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 039 — add_booking_intent_hold_snapshot_columns
 *
 * Adds the columns required for the Postgres repository to persist the full
 * `BookingIntentRecord` domain object, matching the in-memory repository:
 *
 *  - `booking_type`                TEXT DEFAULT 'standard'
 *  - `hold_until_ms`               BIGINT
 *  - `hold_placed_at`              TIMESTAMPTZ
 *  - `refunded_at`                 TIMESTAMPTZ
 *  - `refund_metadata`             JSONB
 *  - `pricing_snapshot`            JSONB
 *  - `cancellation_policy_snapshot` JSONB
 *  - `hold_fee_policy_snapshot`    JSONB
 *
 * The snapshot columns are stored as JSONB because the domain types
 * (PricingSnapshot, CancellationPolicySnapshot, HoldFeePolicySnapshot) are
 * complex nested objects that are consumed by the service layer and do not
 * need to be individually queryable.  `refunded_at` and `refund_metadata`
 * record the outcome of a hold refund.
 *
 * This migration is additive only; it does not change existing columns or
 * constraints, so it is safe to apply on a populated table.
 */
export const migration: Migration = {
  id: "039",
  name: "add_booking_intent_hold_snapshot_columns",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE booking_intents
        ADD COLUMN IF NOT EXISTS booking_type TEXT DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS hold_until_ms BIGINT,
        ADD COLUMN IF NOT EXISTS hold_placed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS refund_metadata JSONB,
        ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB,
        ADD COLUMN IF NOT EXISTS cancellation_policy_snapshot JSONB,
        ADD COLUMN IF NOT EXISTS hold_fee_policy_snapshot JSONB
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE booking_intents
        DROP COLUMN IF EXISTS booking_type,
        DROP COLUMN IF EXISTS hold_until_ms,
        DROP COLUMN IF EXISTS hold_placed_at,
        DROP COLUMN IF EXISTS refunded_at,
        DROP COLUMN IF EXISTS refund_metadata,
        DROP COLUMN IF EXISTS pricing_snapshot,
        DROP COLUMN IF EXISTS cancellation_policy_snapshot,
        DROP COLUMN IF EXISTS hold_fee_policy_snapshot
    `);
  },
};
