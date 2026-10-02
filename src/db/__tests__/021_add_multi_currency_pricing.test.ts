/**
 * 021_add_multi_currency_pricing.test.ts
 *
 * Focused behavior coverage for the `add_multi_currency_pricing` migration
 * (Issue #1063).
 *
 * The migration is pure SQL orchestration, so the observable contract is the
 * exact statements emitted, in a deterministic order, plus stop-on-first-failure
 * error propagation for both `up()` and `down()`.
 */

import { describe, it, expect, jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../migrations/021_add_multi_currency_pricing.js";

// ── Fakes & helpers ──────────────────────────────────────────────────────────

interface QuerySpy {
  client: PoolClient;
  queries: Array<{ sql: string; params: unknown[] }>;
}

function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function makeClient(options: { failOn?: RegExp } = {}): QuerySpy {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql: normalise(sql), params });
    if (options.failOn && options.failOn.test(sql)) {
      throw new Error("boom: statement rejected by the database");
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  return { client, queries };
}

// ── Static contract ──────────────────────────────────────────────────────────

describe("migration 021 — static contract", () => {
  it("exports the correct id", () => {
    expect(migration.id).toBe("021");
  });

  it("exports the correct name", () => {
    expect(migration.name).toBe("add_multi_currency_pricing");
  });

  it("exports up() and down() functions", () => {
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });
});

// ── up() ─────────────────────────────────────────────────────────────────────

describe("migration 021 — up()", () => {
  it("executes exactly two statements", async () => {
    const { client, queries } = makeClient();
    await migration.up(client);
    expect(queries).toHaveLength(2);
  });

  it("adds currency and amount_minor to slots", async () => {
    const { client, queries } = makeClient();
    await migration.up(client);

    const [first] = queries;
    expect(first.sql).toMatch(/ALTER TABLE slots/i);
    expect(first.sql).toMatch(/ADD COLUMN currency VARCHAR\(3\)/i);
    expect(first.sql).toMatch(/ADD COLUMN amount_minor BIGINT/i);
  });

  it("adds fx_rate_snapshot JSONB to booking_intents", async () => {
    const { client, queries } = makeClient();
    await migration.up(client);

    const second = queries[1];
    expect(second.sql).toMatch(/ALTER TABLE booking_intents/i);
    expect(second.sql).toMatch(/ADD COLUMN fx_rate_snapshot JSONB/i);
  });

  it("runs the slots change before the booking_intents change", async () => {
    const { client, queries } = makeClient();
    await migration.up(client);
    expect(queries[0].sql).toMatch(/ALTER TABLE slots/i);
    expect(queries[1].sql).toMatch(/ALTER TABLE booking_intents/i);
  });

  it("emits no bound parameters (DDL only)", async () => {
    const { client, queries } = makeClient();
    await migration.up(client);
    for (const q of queries) {
      expect(q.params).toEqual([]);
    }
  });

  it("resolves without throwing when every statement succeeds", async () => {
    const { client } = makeClient();
    await expect(migration.up(client)).resolves.toBeUndefined();
  });

  it("propagates a failure from the first statement and stops", async () => {
    const { client, queries } = makeClient({ failOn: /ALTER TABLE slots/i });
    await expect(migration.up(client)).rejects.toThrow("statement rejected");
    expect(queries).toHaveLength(1);
  });

  it("propagates a failure from the second statement", async () => {
    const { client, queries } = makeClient({ failOn: /ALTER TABLE booking_intents/i });
    await expect(migration.up(client)).rejects.toThrow("statement rejected");
    expect(queries).toHaveLength(2);
  });
});

// ── down() ───────────────────────────────────────────────────────────────────

describe("migration 021 — down()", () => {
  it("executes exactly two statements", async () => {
    const { client, queries } = makeClient();
    await migration.down(client);
    expect(queries).toHaveLength(2);
  });

  it("drops fx_rate_snapshot from booking_intents", async () => {
    const { client, queries } = makeClient();
    await migration.down(client);

    expect(queries[0].sql).toMatch(/ALTER TABLE booking_intents/i);
    expect(queries[0].sql).toMatch(/DROP COLUMN fx_rate_snapshot/i);
  });

  it("drops amount_minor and currency from slots", async () => {
    const { client, queries } = makeClient();
    await migration.down(client);

    const second = queries[1].sql;
    expect(second).toMatch(/ALTER TABLE slots/i);
    expect(second).toMatch(/DROP COLUMN amount_minor/i);
    expect(second).toMatch(/DROP COLUMN currency/i);
  });

  it("drops booking_intents data before slots (reverse of up order)", async () => {
    const { client, queries } = makeClient();
    await migration.down(client);
    expect(queries[0].sql).toMatch(/ALTER TABLE booking_intents/i);
    expect(queries[1].sql).toMatch(/ALTER TABLE slots/i);
  });

  it("resolves without throwing when every statement succeeds", async () => {
    const { client } = makeClient();
    await expect(migration.down(client)).resolves.toBeUndefined();
  });

  it("propagates a failure and stops", async () => {
    const { client, queries } = makeClient({ failOn: /ALTER TABLE booking_intents/i });
    await expect(migration.down(client)).rejects.toThrow("statement rejected");
    expect(queries).toHaveLength(1);
  });
});

// ── up/down symmetry ─────────────────────────────────────────────────────────

describe("migration 021 — up/down symmetry", () => {
  it("removes exactly the columns that up() adds", async () => {
    const added = new Set<string>();
    const removed = new Set<string>();

    const up = makeClient();
    await migration.up(up.client);
    for (const q of up.queries) {
      for (const m of q.sql.matchAll(/ADD COLUMN (\w+)/gi)) added.add(m[1]);
    }

    const down = makeClient();
    await migration.down(down.client);
    for (const q of down.queries) {
      for (const m of q.sql.matchAll(/DROP COLUMN (\w+)/gi)) removed.add(m[1]);
    }

    expect([...removed].sort()).toEqual([...added].sort());
  });
});
