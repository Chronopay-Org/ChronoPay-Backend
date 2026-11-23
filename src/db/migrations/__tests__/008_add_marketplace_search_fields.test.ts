/**
 * Focused behaviour coverage for
 * src/db/migrations/008_add_marketplace_search_fields.ts (Issue #1039).
 *
 * The migration is pure SQL orchestration, so the tests inject a recording
 * PoolClient and assert the exact statements, their order, that no values are
 * bound, and that database errors propagate instead of being swallowed.
 */
import { describe, it, expect, jest } from "@jest/globals";
import type { PoolClient } from "pg";

import { migration } from "../008_add_marketplace_search_fields.js";

interface QueryCall {
  text: string;
  values?: unknown[];
}

function createClient() {
  const calls: QueryCall[] = [];
  const query = jest.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    return { rows: [] as Record<string, unknown>[] };
  });
  return { client: { query } as unknown as PoolClient, calls, query };
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

describe("migration 008_add_marketplace_search_fields", () => {
  it("exposes the id and name registered by the migration registry", () => {
    expect(migration.id).toBe("009");
    expect(migration.name).toBe("add_marketplace_search_fields");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up() adds the three marketplace search columns with non-null defaults", async () => {
    const { client, calls } = createClient();

    await migration.up(client);

    const sql = calls.map((call) => normalize(call.text));
    expect(sql).toHaveLength(6);
    expect(sql[0]).toContain("ALTER TABLE slots");
    expect(sql[0]).toContain("ADD COLUMN category VARCHAR(100) NOT NULL DEFAULT 'general'");
    expect(sql[0]).toContain("ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0");
    expect(sql[0]).toContain("ADD COLUMN supplier_rating NUMERIC(3,2) NOT NULL DEFAULT 0.00");
  });

  it("up() adds the price and rating check constraints", async () => {
    const { client, calls } = createClient();

    await migration.up(client);

    const sql = calls.map((call) => normalize(call.text));
    expect(sql[1]).toContain("ADD CONSTRAINT chk_slots_price_non_negative CHECK (price_cents >= 0)");
    expect(sql[2]).toContain(
      "ADD CONSTRAINT chk_slots_rating_valid CHECK (supplier_rating >= 0 AND supplier_rating <= 5)",
    );
  });

  it("up() creates the filter, sort and deterministic-pagination indexes", async () => {
    const { client, calls } = createClient();

    await migration.up(client);

    const sql = calls.map((call) => normalize(call.text));
    expect(sql[3]).toContain("CREATE INDEX idx_slots_category ON slots (category)");
    expect(sql[4]).toContain(
      "CREATE INDEX idx_slots_supplier_rating ON slots (supplier_rating DESC)",
    );
    expect(sql[5]).toContain(
      "CREATE INDEX idx_slots_search_ranking ON slots (category, supplier_rating DESC, id)",
    );
  });

  it("up() binds no query parameters", async () => {
    const { client, calls } = createClient();

    await migration.up(client);

    for (const call of calls) {
      expect(call.values).toBeUndefined();
    }
  });

  it("up() surfaces database errors instead of swallowing them", async () => {
    const failure = new Error('relation "slots" does not exist');
    const query = jest.fn(async () => {
      throw failure;
    });
    const client = { query } as unknown as PoolClient;

    await expect(migration.up(client)).rejects.toThrow('relation "slots" does not exist');
    // Stops at the failing statement rather than continuing.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("down() drops the indexes before reverting the columns", async () => {
    const { client, calls } = createClient();

    await migration.down(client);

    const sql = calls.map((call) => normalize(call.text));
    expect(sql).toHaveLength(4);
    expect(sql[0]).toContain("DROP INDEX IF EXISTS idx_slots_search_ranking");
    expect(sql[1]).toContain("DROP INDEX IF EXISTS idx_slots_supplier_rating");
    expect(sql[2]).toContain("DROP INDEX IF EXISTS idx_slots_category");
  });

  it("down() reverts the constraints and columns in one idempotent statement", async () => {
    const { client, calls } = createClient();

    await migration.down(client);

    const last = normalize(calls[3].text);
    expect(last).toContain("ALTER TABLE slots");
    expect(last).toContain("DROP CONSTRAINT IF EXISTS chk_slots_rating_valid");
    expect(last).toContain("DROP CONSTRAINT IF EXISTS chk_slots_price_non_negative");
    expect(last).toContain("DROP COLUMN IF EXISTS supplier_rating");
    expect(last).toContain("DROP COLUMN IF EXISTS price_cents");
    expect(last).toContain("DROP COLUMN IF EXISTS category");
  });

  it("down() is idempotent — every revert guards with IF EXISTS", async () => {
    const { client, calls } = createClient();

    await expect(migration.down(client)).resolves.toBeUndefined();

    const sql = calls.map((call) => normalize(call.text)).join("\n");
    expect(sql).not.toMatch(/DROP (INDEX|CONSTRAINT|COLUMN) (?!IF EXISTS)/);
  });

  it("down() surfaces database errors", async () => {
    const query = jest.fn(async () => {
      throw new Error("permission denied for table slots");
    });
    const client = { query } as unknown as PoolClient;

    await expect(migration.down(client)).rejects.toThrow("permission denied for table slots");
  });
});
