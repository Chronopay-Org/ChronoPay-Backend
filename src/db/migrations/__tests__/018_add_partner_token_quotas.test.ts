/**
 * Migration 018 — `add_partner_token_quotas`
 *
 * Focused behaviour coverage for the migration module. The migration is a
 * pure SQL contract, so the suite drives it with a recording `PoolClient`
 * stub and asserts the exact DDL it is required to emit:
 *   - `up()` creates `partner_token_quotas` with one row per token and the
 *     documented defaults, plus the token lookup index.
 *   - `down()` removes the table idempotently.
 *   - Failures propagate (a migration must not silently swallow errors).
 */

import { describe, it, expect, jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../018_add_partner_token_quotas.js";

function makeClient() {
  const calls: string[] = [];
  const query = jest.fn(async (text: string) => {
    calls.push(text);
    return { rows: [], rowCount: 0 };
  });
  return { client: { query } as unknown as PoolClient, calls, query };
}

describe("migration 018 add_partner_token_quotas", () => {
  it("exposes the migration identity and lifecycle hooks", () => {
    expect(typeof migration.id).toBe("string");
    expect(migration.id.length).toBeGreaterThan(0);
    expect(migration.name).toBe("add_partner_token_quotas");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("creates the quota table with one row per token and the documented defaults", async () => {
    const { client, calls } = makeClient();
    await migration.up(client);

    const sql = calls.join("\n");
    expect(calls.length).toBeGreaterThanOrEqual(2);

    expect(sql).toContain("CREATE TABLE partner_token_quotas");
    // Primary key is the derived token id so upserts keep one row per token.
    expect(sql).toMatch(/token_id\s+TEXT\s+PRIMARY KEY/);
    expect(sql).toMatch(/daily_limit\s+INTEGER\s+NOT NULL\s+DEFAULT 10000/);
    expect(sql).toMatch(/monthly_limit\s+INTEGER\s+NOT NULL\s+DEFAULT 300000/);
    expect(sql).toMatch(/daily_used\s+INTEGER\s+NOT NULL\s+DEFAULT 0/);
    expect(sql).toMatch(/monthly_used\s+INTEGER\s+NOT NULL\s+DEFAULT 0/);
    expect(sql).toMatch(/daily_reset_at\s+TIMESTAMPTZ\s+NOT NULL/);
    expect(sql).toMatch(/monthly_reset_at\s+TIMESTAMPTZ\s+NOT NULL/);
    expect(sql).toMatch(/timezone\s+TEXT\s+NOT NULL\s+DEFAULT 'UTC'/);
    expect(sql).toMatch(/approaching_quota_notified\s+BOOLEAN\s+NOT NULL\s+DEFAULT FALSE/);
    expect(sql).toMatch(/updated_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT NOW\(\)/);
    expect(sql).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT NOW\(\)/);
  });

  it("creates the fast-lookup index for the quota check + consume path", async () => {
    const { client, calls } = makeClient();
    await migration.up(client);

    const sql = calls.join("\n");
    expect(sql).toContain("CREATE INDEX idx_partner_token_quotas_token");
    expect(sql).toMatch(/ON partner_token_quotas\s*\(\s*token_id\s*\)/);
  });

  it("is deterministic: running up() twice emits the same statements", async () => {
    const first = makeClient();
    const second = makeClient();
    await migration.up(first.client);
    await migration.up(second.client);
    expect(second.calls).toEqual(first.calls);
  });

  it("drops the table idempotently on down()", async () => {
    const { client, calls, query } = makeClient();
    await migration.down(client);

    expect(query).toHaveBeenCalledTimes(1);
    expect(calls[0]).toContain("DROP TABLE IF EXISTS partner_token_quotas");
  });

  it("propagates client errors instead of swallowing them", async () => {
    const failing = {
      query: jest.fn(async () => {
        throw new Error("deadlock detected");
      }),
    } as unknown as PoolClient;

    await expect(migration.up(failing)).rejects.toThrow("deadlock detected");
    await expect(migration.down(failing)).rejects.toThrow("deadlock detected");
  });
});
