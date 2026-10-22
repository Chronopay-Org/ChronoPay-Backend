import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "027",
  name: "add_mfa_failed_attempt_lockout",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE mfa_enrollments
        ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        ADD COLUMN locked_until TIMESTAMPTZ
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE mfa_enrollments
        DROP COLUMN locked_until,
        DROP COLUMN failed_attempts
    `);
  },
};
