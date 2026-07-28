import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 012 — create_redemption_ledger
 *
 * Creates the hash-chain redemption ledger that provides cryptographic
 * proof-of-uniqueness for token redemptions.
 *
 * Design decisions:
 *  - `redemption_id` is a UNIQUE application-supplied identifier (e.g. a
 *    UUID issued at request time).  The UNIQUE constraint is the database
 *    enforcement layer that prevents double-spend.
 *  - `entry_hash` is SHA-256(redemption_id || prev_hash || created_at ISO
 *    string).  It chains each entry to its predecessor so that any
 *    retroactive edit to a committed row is detectable by the verifier CLI.
 *  - `prev_hash` is NULL only for the genesis row (the very first entry).
 *    Subsequent rows MUST reference the hash of the immediately preceding
 *    row; the application enforces this under a serialisable transaction.
 *  - `token_id` and `redeemer_id` are plain text references so the ledger
 *    remains independent of the token/user table schema.
 *  - A partial unique index on prev_hash IS NULL guards against more than
 *    one genesis row.
 *  - `metadata` is optional JSONB for extensibility without a schema migration.
 */
export const migration: Migration = {
  id: "012",
  name: "create_redemption_ledger",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE redemption_ledger (
        id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        redemption_id  TEXT        NOT NULL UNIQUE,
        token_id       TEXT        NOT NULL,
        redeemer_id    TEXT        NOT NULL,
        entry_hash     TEXT        NOT NULL UNIQUE,
        prev_hash      TEXT,
        metadata       JSONB,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Only one genesis row allowed (prev_hash IS NULL).
    await client.query(`
      CREATE UNIQUE INDEX idx_redemption_ledger_genesis
        ON redemption_ledger ((prev_hash IS NULL))
        WHERE prev_hash IS NULL
    `);

    // Fast chain-walk: look up a row by its hash value.
    await client.query(`
      CREATE INDEX idx_redemption_ledger_prev_hash
        ON redemption_ledger (prev_hash)
    `);

    // Ordered chain traversal.
    await client.query(`
      CREATE INDEX idx_redemption_ledger_created_at
        ON redemption_ledger (created_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS redemption_ledger`);
  },
};
