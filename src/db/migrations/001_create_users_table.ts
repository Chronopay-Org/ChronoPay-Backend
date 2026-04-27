import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 001 — create_users_table
 *
 * Creates the foundational `users` table.
 *
 * Design decisions:
 *  - UUID primary key with gen_random_uuid() (PostgreSQL 13+, no extension needed)
 *    avoids sequential IDs that would leak business metrics.
 *  - email VARCHAR(320) matches RFC 5321 maximum length.
 *  - TIMESTAMPTZ (timezone-aware) prevents UTC/local recording ambiguity.
 *  - Separate index on email for fast lookup even though UNIQUE already implies one.
 */
export const migration: Migration = {
  id: "001",
  name: "create_users_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE users (
        id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        email      VARCHAR(320) NOT NULL UNIQUE,
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    // Explicit index for fast email lookups (UNIQUE constraint implies one,
    // but naming it explicitly makes monitoring and EXPLAIN output clearer).
    await client.query(`
      CREATE INDEX idx_users_email ON users (email)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // IF EXISTS makes this safe to call even if the migration failed partway.
    await client.query(`DROP TABLE IF EXISTS users`);
  },
};
