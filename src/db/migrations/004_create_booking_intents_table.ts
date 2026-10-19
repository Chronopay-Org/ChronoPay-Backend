import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 004 — create_booking_intents_table
 *
 * Creates the `booking_intents` table and the `booking_intent_status` enum type.
 *
 * Design decisions:
 *  - `booking_intent_status` as a PostgreSQL ENUM restricted to the values the
 *    application can persist (see BookingIntentStatus in
 *    src/modules/booking-intents/booking-intent-repository.ts).  The standard
 *    flow (pending → confirmed → firm → terminal) plus the refundable-hold
 *    flow (hold_placed → hold_refunded) and escrow lifecycle states.  `completed`
 *    is kept for backward compatibility with databases created before the
 *    hold/escrow statuses were introduced; the application never writes it.
 *  - `slot_id` starts with a UNIQUE constraint which migration 024 later
 *    replaces with a partial unique index covering only active intents.
 *  - `professional_id` and `customer_id` reference the `users` table.
 *  - `start_time` and `end_time` are TIMESTAMPTZ to match the `slots` table.
 */
export const migration: Migration = {
  id: "004",
  name: "create_booking_intents_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TYPE booking_intent_status AS ENUM (
        'pending',
        'confirmed',
        'firm',
        'completed',
        'cancelled',
        'expired',
        'hold_placed',
        'hold_refunded',
        'escrow_held',
        'escrow_released',
        'escrow_refunded',
        'escrow_disputed',
        'no_show'
      )
    `);

    await client.query(`
      CREATE TABLE booking_intents (
        id              UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
        slot_id         UUID                  NOT NULL UNIQUE REFERENCES slots(id) ON DELETE CASCADE,
        professional_id UUID                  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        customer_id     UUID                  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        start_time      TIMESTAMPTZ           NOT NULL,
        end_time        TIMESTAMPTZ           NOT NULL,
        status          booking_intent_status NOT NULL DEFAULT 'pending',
        note            TEXT,
        created_at      TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_booking_intents_time_order CHECK (end_time > start_time)
      )
    `);

    await client.query(`
      CREATE INDEX idx_booking_intents_slot_id ON booking_intents (slot_id)
    `);

    await client.query(`
      CREATE INDEX idx_booking_intents_customer_id ON booking_intents (customer_id)
    `);

    await client.query(`
      CREATE INDEX idx_booking_intents_professional_id ON booking_intents (professional_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS booking_intents`);
    await client.query(`DROP TYPE IF EXISTS booking_intent_status`);
  },
};
