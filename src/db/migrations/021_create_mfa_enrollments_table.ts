import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 021 — create_mfa_enrollments_table
 *
 * Stores per-user TOTP MFA enrollments with the TOTP secret encrypted at rest.
 *
 * Design decisions:
 *  - `user_id` is a TEXT primary key (NOT a FK to users(id)) because
 *    authenticated identities in this service come from JWT claims or the
 *    `x-chronopay-user-id` header, and not every identity is guaranteed to
 *    have a row in `users`. Enrolment is still gated server-side by the auth
 *    middleware, and rows are deleted by the GDPR erasure path.
 *  - Cipher fields split into dedicated columns (ciphertext / iv / auth tag /
 *    KDF salt) so the row is fully self-describing: a fresh decrypt needs no
 *    external metadata, and the GCM auth tag provides end-to-end tamper
 *    detection (see src/services/mfaCrypto.ts).
 *  - `last_used_counter` tracks the highest TOTP counter step successfully
 *    verified per user. Replay protection is enforced in-app with a
 *    conditional UPDATE (`... WHERE user_id = $1 AND (last_used_counter < $2
 *    OR last_used_counter IS NULL)`) which is safe under concurrency: only one
 *    of two simultaneous requests with the same step can win.
 *  - `verified` distinguishes a pending enrollment (secret issued, not yet
 *    confirmed) from an active one. Pending rows can be replaced with a fresh
 *    secret; verified rows require a deliberate re-enrolment flow.
 *  - fixed 6-digit / 30-second / SHA1 defaults match the RFC 6238 parameters
 *    used by mainstream authenticator apps.
 */
export const migration: Migration = {
  id: "021",
  name: "create_mfa_enrollments_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE mfa_enrollments (
        user_id            TEXT         PRIMARY KEY,
        secret_ciphertext  TEXT         NOT NULL,
        secret_iv          TEXT         NOT NULL,
        secret_auth_tag    TEXT         NOT NULL,
        kdf_salt           TEXT         NOT NULL,
        algorithm          VARCHAR(16)  NOT NULL DEFAULT 'SHA1',
        digits             SMALLINT     NOT NULL DEFAULT 6 CHECK (digits BETWEEN 6 AND 10),
        period             INTEGER      NOT NULL DEFAULT 30 CHECK (period > 0),
        verified           BOOLEAN      NOT NULL DEFAULT FALSE,
        last_used_counter  BIGINT       CHECK (last_used_counter IS NULL OR last_used_counter >= 0),
        created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      COMMENT ON TABLE mfa_enrollments IS
        'Per-user TOTP MFA enrollments with the secret encrypted at rest (AES-256-GCM, per-user HKDF-derived key)'
    `);
    await client.query(`
      CREATE INDEX mfa_enrollments_verified_idx ON mfa_enrollments (verified)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP INDEX IF EXISTS mfa_enrollments_verified_idx`);
    await client.query(`DROP TABLE IF EXISTS mfa_enrollments`);
  },
};