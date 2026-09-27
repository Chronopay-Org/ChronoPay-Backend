/**
 * Tests for src/db/migrations/020_create_escrow_holdings_table.ts
 *
 * Strategy:
 *   - Inject a hand-rolled mock PoolClient so every test observes exactly
 *     the SQL statements that the migration emits, without any real database.
 *   - The pg module is auto-mapped to test/mocks/pg.ts by Jest, so no
 *     jest.mock() call is required here.
 *   - Each test resets the call log in beforeEach to avoid cross-test
 *     contamination.
 *
 * Covered behaviours:
 *   up()
 *     ✓ creates the escrow_holding_status ENUM type
 *     ✓ creates the escrow_holdings table
 *     ✓ adds the (stellar_tx_hash, event_index) unique index for idempotency
 *     ✓ adds the partial index on booking_intent_id
 *     ✓ adds the partial index on slot_id
 *     ✓ adds the index on status
 *     ✓ adds the index on ledger_seq
 *     ✓ executes exactly 7 queries
 *     ✓ propagates a client.query rejection without swallowing it
 *
 *   down()
 *     ✓ drops the escrow_holdings table with IF EXISTS
 *     ✓ drops the escrow_holding_status type with IF EXISTS
 *     ✓ executes exactly 2 queries
 *     ✓ propagates a client.query rejection without swallowing it
 *
 *   public contract
 *     ✓ id is "020"
 *     ✓ name is "create_escrow_holdings_table"
 *     ✓ up and down are functions
 *
 *   idempotency / round-trip
 *     ✓ up() then down() issues DROP TABLE IF EXISTS (safe to replay)
 *     ✓ down() called without a prior up() still issues DROP TABLE IF EXISTS
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { PoolClient } from "pg";
import { migration } from "../../db/migrations/020_create_escrow_holdings_table.js";

// ─── Mock PoolClient ──────────────────────────────────────────────────────────

type QueryCall = { text: string };

function makeMockClient(): {
  client: PoolClient;
  calls: () => QueryCall[];
  reset: () => void;
} {
  const log: QueryCall[] = [];
  const queryFn = jest
    .fn<(text: string) => Promise<{ rows: unknown[] }>>()
    .mockImplementation(async (text: string) => {
      log.push({ text });
      return { rows: [] };
    });

  const client = { query: queryFn, release: jest.fn() } as unknown as PoolClient;
  return {
    client,
    calls: () => [...log],
    reset: () => log.splice(0, log.length),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalise whitespace so multi-line SQL comparisons are stable. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function calledTexts(calls: QueryCall[]): string[] {
  return calls.map((c) => normalise(c.text));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("migration 020 — public contract", () => {
  it("has id '020'", () => {
    expect(migration.id).toBe("020");
  });

  it("has name 'create_escrow_holdings_table'", () => {
    expect(migration.name).toBe("create_escrow_holdings_table");
  });

  it("exposes up as a function", () => {
    expect(typeof migration.up).toBe("function");
  });

  it("exposes down as a function", () => {
    expect(typeof migration.down).toBe("function");
  });
});

describe("migration 020 — up()", () => {
  let mock: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    mock = makeMockClient();
  });

  it("creates the escrow_holding_status ENUM type", async () => {
    await migration.up(mock.client);
    const texts = calledTexts(mock.calls());
    expect(texts.some((t) => t.includes("create type escrow_holding_status"))).toBe(true);
  });

  it("includes all four status variants in the ENUM definition", async () => {
    await migration.up(mock.client);
    const enumStatement = calledTexts(mock.calls()).find((t) =>
      t.includes("create type escrow_holding_status"),
    );
    expect(enumStatement).toBeDefined();
    expect(enumStatement).toContain("'held'");
    expect(enumStatement).toContain("'released'");
    expect(enumStatement).toContain("'refunded'");
    expect(enumStatement).toContain("'slashed'");
  });

  it("creates the escrow_holdings table", async () => {
    await migration.up(mock.client);
    const texts = calledTexts(mock.calls());
    expect(texts.some((t) => t.includes("create table escrow_holdings"))).toBe(true);
  });

  it("escrow_holdings table includes required columns", async () => {
    await migration.up(mock.client);
    const tableStatement = calledTexts(mock.calls()).find((t) =>
      t.includes("create table escrow_holdings"),
    );
    expect(tableStatement).toBeDefined();
    expect(tableStatement).toContain("id");
    expect(tableStatement).toContain("booking_intent_id");
    expect(tableStatement).toContain("slot_id");
    expect(tableStatement).toContain("amount");
    expect(tableStatement).toContain("currency");
    expect(tableStatement).toContain("status");
    expect(tableStatement).toContain("contract_address");
    expect(tableStatement).toContain("stellar_tx_hash");
    expect(tableStatement).toContain("event_index");
    expect(tableStatement).toContain("ledger_seq");
    expect(tableStatement).toContain("created_at");
    expect(tableStatement).toContain("updated_at");
  });

  it("adds a unique index on (stellar_tx_hash, event_index) for idempotency", async () => {
    await migration.up(mock.client);
    const texts = calledTexts(mock.calls());
    const idxStatement = texts.find((t) => t.includes("stellar_tx_hash") && t.includes("unique"));
    expect(idxStatement).toBeDefined();
    expect(idxStatement).toContain("event_index");
  });

  it("adds a partial index on booking_intent_id", async () => {
    await migration.up(mock.client);
    const texts = calledTexts(mock.calls());
    expect(
      texts.some(
        (t) =>
          t.includes("booking_intent_id") &&
          t.includes("index") &&
          t.includes("where"),
      ),
    ).toBe(true);
  });

  it("adds a partial index on slot_id", async () => {
    await migration.up(mock.client);
    const texts = calledTexts(mock.calls());
    expect(
      texts.some(
        (t) =>
          t.includes("slot_id") &&
          t.includes("index") &&
          t.includes("where"),
      ),
    ).toBe(true);
  });

  it("adds an index on status", async () => {
    await migration.up(mock.client);
    const texts = calledTexts(mock.calls());
    expect(
      texts.some((t) => t.includes("idx_escrow_holdings_status") && t.includes("index")),
    ).toBe(true);
  });

  it("adds an index on ledger_seq", async () => {
    await migration.up(mock.client);
    const texts = calledTexts(mock.calls());
    expect(
      texts.some(
        (t) => t.includes("ledger_seq") && t.includes("index"),
      ),
    ).toBe(true);
  });

  it("executes exactly 7 queries (1 ENUM + 1 TABLE + 5 INDEXes)", async () => {
    await migration.up(mock.client);
    expect(mock.calls()).toHaveLength(7);
  });

  it("resolves without a return value", async () => {
    const result = await migration.up(mock.client);
    expect(result).toBeUndefined();
  });

  it("propagates a client.query rejection — first query fails", async () => {
    const boom = new Error("CREATE TYPE failed — type already exists");
    const faultyClient = {
      query: jest.fn<(text: string) => Promise<never>>().mockRejectedValueOnce(boom),
      release: jest.fn(),
    } as unknown as PoolClient;

    await expect(migration.up(faultyClient)).rejects.toThrow(
      "CREATE TYPE failed — type already exists",
    );
  });

  it("propagates a client.query rejection — table creation fails", async () => {
    const boom = new Error("CREATE TABLE failed — insufficient privilege");
    const callCount = { n: 0 };
    const faultyClient = {
      query: jest
        .fn<(text: string) => Promise<{ rows: unknown[] }>>()
        .mockImplementation(async () => {
          callCount.n++;
          if (callCount.n === 2) throw boom;
          return { rows: [] };
        }),
      release: jest.fn(),
    } as unknown as PoolClient;

    await expect(migration.up(faultyClient)).rejects.toThrow(
      "CREATE TABLE failed — insufficient privilege",
    );
  });
});

describe("migration 020 — down()", () => {
  let mock: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    mock = makeMockClient();
  });

  it("drops the escrow_holdings table with IF EXISTS", async () => {
    await migration.down(mock.client);
    const texts = calledTexts(mock.calls());
    expect(
      texts.some(
        (t) => t.includes("drop table if exists") && t.includes("escrow_holdings"),
      ),
    ).toBe(true);
  });

  it("drops the escrow_holding_status type with IF EXISTS", async () => {
    await migration.down(mock.client);
    const texts = calledTexts(mock.calls());
    expect(
      texts.some(
        (t) => t.includes("drop type if exists") && t.includes("escrow_holding_status"),
      ),
    ).toBe(true);
  });

  it("drops table before dropping type (dependency order)", async () => {
    await migration.down(mock.client);
    const texts = calledTexts(mock.calls());
    const tableIdx = texts.findIndex((t) => t.includes("drop table if exists"));
    const typeIdx = texts.findIndex((t) => t.includes("drop type if exists"));
    expect(tableIdx).toBeGreaterThanOrEqual(0);
    expect(typeIdx).toBeGreaterThan(tableIdx);
  });

  it("executes exactly 2 queries", async () => {
    await migration.down(mock.client);
    expect(mock.calls()).toHaveLength(2);
  });

  it("resolves without a return value", async () => {
    const result = await migration.down(mock.client);
    expect(result).toBeUndefined();
  });

  it("propagates a client.query rejection", async () => {
    const boom = new Error("DROP TABLE failed — permission denied");
    const faultyClient = {
      query: jest.fn<(text: string) => Promise<never>>().mockRejectedValueOnce(boom),
      release: jest.fn(),
    } as unknown as PoolClient;

    await expect(migration.down(faultyClient)).rejects.toThrow(
      "DROP TABLE failed — permission denied",
    );
  });

  it("is safe to call without a prior up() — DROP TABLE IF EXISTS never throws", async () => {
    // The mock always succeeds; the important assertion is that down() completes.
    await expect(migration.down(mock.client)).resolves.toBeUndefined();
    expect(mock.calls()).toHaveLength(2);
  });
});

describe("migration 020 — idempotency / round-trip", () => {
  let mock: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    mock = makeMockClient();
  });

  it("up() followed by down() issues a safe IF EXISTS drop", async () => {
    await migration.up(mock.client);
    mock.reset();
    await migration.down(mock.client);

    const texts = calledTexts(mock.calls());
    expect(
      texts.some(
        (t) => t.includes("drop table if exists") && t.includes("escrow_holdings"),
      ),
    ).toBe(true);
  });

  it("SQL emitted by up() and down() is deterministic across repeated calls", async () => {
    await migration.up(mock.client);
    const firstUpTexts = calledTexts(mock.calls());
    mock.reset();

    await migration.up(mock.client);
    const secondUpTexts = calledTexts(mock.calls());

    expect(firstUpTexts).toEqual(secondUpTexts);
  });
});
