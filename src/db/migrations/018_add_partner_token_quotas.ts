import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 018 — add_partner_token_quotas
 *
 * Creates the partner_token_quotas table for tracking daily and monthly
 * usage limits per API token, with configurable timezone-based reset.
 *
 * Design decisions:
 *  - `token_id` is the derived API key ID (apiKey_<sha256>) acting as PK so
 *    there is exactly one quota row per token — upsert semantics.
 *  - `daily_limit` / `monthly_limit` define the maximum allowed requests in
 *    each window.  Defaults are reasonable for initial rollout; operators
 *    UPDATE in-place to adjust per partner.
 *  - `daily_used` / `monthly_used` are accumulated counters reset to 0 when
 *    `daily_reset_at` / `monthly_reset_at` elapses.
 *  - `daily_reset_at` / `monthly_reset_at` encode the *next* reset timestamp.
 *    The application checks `NOW() >= reset_at` on every access and resets
 *    the corresponding counter + advances the timestamp by one window.
 *  - `timezone` is an IANA timezone identifier (e.g. "America/New_York")
 *    that determines the wall-clock midnight / month boundary for resets.
 *    This allows each partner's quota to reset at their local midnight
 *    regardless of server timezone.
 *  - `approaching_quota_notified` is a boolean flag that prevents repeatedly
 *    emitting the "approaching quota" alarm for the same token — it is
 *    cleared on counter reset and set when usage crosses the threshold.
 */
export const migration: Migration = {
  id: "018",
  name: "add_partner_token_quotas",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE partner_token_quotas (
        token_id                   TEXT        PRIMARY KEY,
        daily_limit                INTEGER     NOT NULL DEFAULT 10000,
        monthly_limit              INTEGER     NOT NULL DEFAULT 300000,
        daily_used                 INTEGER     NOT NULL DEFAULT 0,
        monthly_used               INTEGER     NOT NULL DEFAULT 0,
        daily_reset_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        monthly_reset_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        timezone                   TEXT        NOT NULL DEFAULT 'UTC',
        approaching_quota_notified BOOLEAN     NOT NULL DEFAULT FALSE,
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Fast lookup by token_id for the quota check + consume path.
    await client.query(`
      CREATE INDEX idx_partner_token_quotas_token
        ON partner_token_quotas (token_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS partner_token_quotas`);
  },
};
