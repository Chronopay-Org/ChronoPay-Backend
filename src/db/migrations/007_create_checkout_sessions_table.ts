import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 007 — create_checkout_sessions_table
 *
 * Design decisions:
 *  - `checkout_session_status` ENUM restricts allowed statuses.
 *  - `payment` and `customer` stored as JSONB for schema flexibility.
 *  - `expires_at` is a TIMESTAMPTZ column; expiry is computed by comparing
 *    NOW() against it — no in-process timer needed.
 *  - Index on `expires_at` supports efficient TTL-based cleanup queries.
 */
export const migration: Migration = {
  id: "007",
  name: "create_checkout_sessions_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TYPE checkout_session_status AS ENUM (
        'pending', 'completed', 'failed', 'expired', 'cancelled'
      )
    `);

    await client.query(`
      CREATE TABLE checkout_sessions (
        id              UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
        payment         JSONB                    NOT NULL,
        customer        JSONB                    NOT NULL,
        status          checkout_session_status  NOT NULL DEFAULT 'pending',
        metadata        JSONB,
        success_url     TEXT,
        cancel_url      TEXT,
        payment_token   TEXT,
        created_at      TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
        expires_at      TIMESTAMPTZ              NOT NULL
      )
    `);

    await client.query(`
      CREATE INDEX idx_checkout_sessions_expires_at ON checkout_sessions (expires_at)
    `);

    await client.query(`
      CREATE INDEX idx_checkout_sessions_status ON checkout_sessions (status)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS checkout_sessions`);
    await client.query(`DROP TYPE IF EXISTS checkout_session_status`);
  },
};
