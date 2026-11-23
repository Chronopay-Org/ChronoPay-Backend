import { jest } from "@jest/globals";
import { migration } from "../migrations/021a_create_subscription_products.js";
import type { PoolClient } from "pg";

/**
 * Unit tests for migration 021a — create_subscription_products.
 *
 * Strategy: inject a Jest-mocked PoolClient so that no real database is
 * required. Each test controls the mock's resolved/rejected state to drive
 * the specific success or failure scenario being exercised.
 */

type MockQuery = ReturnType<typeof jest.fn>;

function makeMockClient(queryImpl?: MockQuery): PoolClient {
  const query = queryImpl ?? jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  return {
    query,
    release: jest.fn(),
  } as unknown as PoolClient;
}

// ── Static shape ────────────────────────────────────────────────────────────

describe("migration 021a — static contract", () => {
  it("exports the correct id", () => {
    expect(migration.id).toBe("021a");
  });

  it("exports the correct name", () => {
    expect(migration.name).toBe("create_subscription_products");
  });

  it("exports an up() function", () => {
    expect(typeof migration.up).toBe("function");
  });

  it("exports a down() function", () => {
    expect(typeof migration.down).toBe("function");
  });
});

// ── up() — success path ─────────────────────────────────────────────────────

describe("migration 021a — up()", () => {
  it("executes exactly three queries", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = makeMockClient(query);

    await migration.up(client);

    expect(query).toHaveBeenCalledTimes(3);
  });

  it("first query creates the subscription_products table", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = makeMockClient(query);

    await migration.up(client);

    const firstCall = query.mock.calls[0][0] as string;
    expect(firstCall).toMatch(/CREATE TABLE IF NOT EXISTS subscription_products/i);
  });

  it("first query includes all required columns", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = makeMockClient(query);

    await migration.up(client);

    const ddl = query.mock.calls[0][0] as string;
    const expectedColumns = [
      "id",
      "name",
      "description",
      "professional",
      "slot_duration_ms",
      "recurrence_rule",
      "timezone",
      "price_cents",
      "currency",
      "max_subscribers",
      "active",
      "created_at",
      "updated_at",
    ];
    for (const col of expectedColumns) {
      expect(ddl).toContain(col);
    }
  });

  it("first query enforces slot_duration_ms > 0 constraint", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = makeMockClient(query);

    await migration.up(client);

    const ddl = query.mock.calls[0][0] as string;
    expect(ddl).toMatch(/slot_duration_ms.*CHECK.*slot_duration_ms\s*>\s*0/s);
  });

  it("first query enforces price_cents >= 0 constraint", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = makeMockClient(query);

    await migration.up(client);

    const ddl = query.mock.calls[0][0] as string;
    expect(ddl).toMatch(/price_cents.*CHECK.*price_cents\s*>=\s*0/s);
  });

  it("second query creates the index on professional", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = makeMockClient(query);

    await migration.up(client);

    const secondCall = query.mock.calls[1][0] as string;
    expect(secondCall).toMatch(/CREATE INDEX/i);
    expect(secondCall).toContain("idx_subscription_products_professional");
    expect(secondCall).toMatch(/ON subscription_products\s*\(professional\)/i);
  });

  it("third query creates the partial index on active", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = makeMockClient(query);

    await migration.up(client);

    const thirdCall = query.mock.calls[2][0] as string;
    expect(thirdCall).toMatch(/CREATE INDEX/i);
    expect(thirdCall).toContain("idx_subscription_products_active");
    expect(thirdCall).toMatch(/ON subscription_products\s*\(active\)/i);
    expect(thirdCall).toMatch(/WHERE active\s*=\s*TRUE/i);
  });

  it("resolves without throwing when all queries succeed", async () => {
    const client = makeMockClient();
    await expect(migration.up(client)).resolves.toBeUndefined();
  });

  it("propagates an error thrown by the CREATE TABLE query", async () => {
    const dbError = new Error("duplicate table: subscription_products");
    const query = jest.fn().mockRejectedValueOnce(dbError);
    const client = makeMockClient(query);

    await expect(migration.up(client)).rejects.toThrow(
      "duplicate table: subscription_products",
    );
  });

  it("propagates an error thrown by the first CREATE INDEX query", async () => {
    const indexError = new Error("index already exists: idx_subscription_products_professional");
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE succeeds
      .mockRejectedValueOnce(indexError);               // first CREATE INDEX fails
    const client = makeMockClient(query);

    await expect(migration.up(client)).rejects.toThrow(
      "index already exists: idx_subscription_products_professional",
    );
  });

  it("propagates an error thrown by the second CREATE INDEX query", async () => {
    const indexError = new Error("index already exists: idx_subscription_products_active");
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE succeeds
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // first CREATE INDEX succeeds
      .mockRejectedValueOnce(indexError);               // second CREATE INDEX fails
    const client = makeMockClient(query);

    await expect(migration.up(client)).rejects.toThrow(
      "index already exists: idx_subscription_products_active",
    );
  });

  it("does not call further queries after a failure in the first query", async () => {
    const dbError = new Error("connection reset");
    const query = jest.fn().mockRejectedValue(dbError);
    const client = makeMockClient(query);

    await expect(migration.up(client)).rejects.toThrow("connection reset");

    // Only the first query is attempted before the error propagates
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("queries are called in the correct order (table first, then indexes)", async () => {
    const callOrder: string[] = [];
    const query = jest.fn().mockImplementation(async (sql: unknown) => {
      const s = sql as string;
      if (/CREATE TABLE/i.test(s)) callOrder.push("table");
      else if (/idx_subscription_products_professional/i.test(s)) callOrder.push("idx_professional");
      else if (/idx_subscription_products_active/i.test(s)) callOrder.push("idx_active");
      return { rows: [], rowCount: 0 };
    });
    const client = makeMockClient(query);

    await migration.up(client);

    expect(callOrder).toEqual(["table", "idx_professional", "idx_active"]);
  });
});

// ── down() — success path ───────────────────────────────────────────────────

describe("migration 021a — down()", () => {
  it("executes exactly one query", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = makeMockClient(query);

    await migration.down(client);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("drops the subscription_products table", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = makeMockClient(query);

    await migration.down(client);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/DROP TABLE IF EXISTS subscription_products/i);
  });

  it("resolves without throwing when the query succeeds", async () => {
    const client = makeMockClient();
    await expect(migration.down(client)).resolves.toBeUndefined();
  });

  it("propagates an error thrown by the DROP TABLE query", async () => {
    const dbError = new Error("permission denied for table subscription_products");
    const query = jest.fn().mockRejectedValueOnce(dbError);
    const client = makeMockClient(query);

    await expect(migration.down(client)).rejects.toThrow(
      "permission denied for table subscription_products",
    );
  });

  it("uses IF EXISTS so down() is safe to run even when the table is absent", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const client = makeMockClient(query);

    await migration.down(client);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/DROP TABLE IF EXISTS/i);
  });
});

// ── round-trip symmetry ─────────────────────────────────────────────────────

describe("migration 021a — up/down symmetry", () => {
  it("up then down each call the client without throwing (happy path round-trip)", async () => {
    const upQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const downQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

    await migration.up(makeMockClient(upQuery));
    await migration.down(makeMockClient(downQuery));

    // up: 3 DDL statements, down: 1 DROP TABLE
    expect(upQuery).toHaveBeenCalledTimes(3);
    expect(downQuery).toHaveBeenCalledTimes(1);
  });
});
