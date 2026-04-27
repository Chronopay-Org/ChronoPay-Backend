/**
 * Tests for src/db/migrationRepository.ts
 *
 * Strategy: inject a plain { query: jest.fn() } object as the client.
 * No pg module mock needed — the repository functions are pure wrappers
 * around parameterized SQL calls, testable with a simple stub.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import {
  ensureMigrationsTable,
  getAppliedMigrations,
  recordMigration,
  removeMigration,
} from "../../db/migrationRepository.js";

// ─── Shared mock client ───────────────────────────────────────────────────────

type MockQuery = jest.MockedFunction<
  (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
>;

let mockQuery: MockQuery;
let client: { query: MockQuery };

beforeEach(() => {
  mockQuery = jest.fn<MockQuery>().mockResolvedValue({ rows: [] });
  client = { query: mockQuery };
});

// ─── ensureMigrationsTable ───────────────────────────────────────────────────

describe("ensureMigrationsTable()", () => {
  it("executes CREATE TABLE IF NOT EXISTS schema_migrations", async () => {
    await ensureMigrationsTable(client);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql: string = (mockQuery.mock.calls[0] as [string])[0];
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS schema_migrations/i);
  });

  it("includes the id, name, and applied_at columns", async () => {
    await ensureMigrationsTable(client);
    const sql: string = (mockQuery.mock.calls[0] as [string])[0];
    expect(sql).toMatch(/id/i);
    expect(sql).toMatch(/name/i);
    expect(sql).toMatch(/applied_at/i);
  });

  it("propagates errors thrown by the client", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB connection lost"));
    await expect(ensureMigrationsTable(client)).rejects.toThrow("DB connection lost");
  });
});

// ─── getAppliedMigrations ────────────────────────────────────────────────────

describe("getAppliedMigrations()", () => {
  it("returns an empty array when no rows exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getAppliedMigrations(client);
    expect(result).toEqual([]);
  });

  it("maps rows to AppliedMigration objects", async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "001", name: "create_users_table", applied_at: now },
        { id: "002", name: "create_slots_table", applied_at: now },
      ],
    });

    const result = await getAppliedMigrations(client);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: "001", name: "create_users_table", applied_at: now });
    expect(result[1]).toEqual({ id: "002", name: "create_slots_table", applied_at: now });
  });

  it("queries schema_migrations ordered by id ASC", async () => {
    await getAppliedMigrations(client);
    const sql: string = (mockQuery.mock.calls[0] as [string])[0];
    expect(sql).toMatch(/schema_migrations/i);
    expect(sql).toMatch(/ORDER BY id ASC/i);
  });

  it("propagates errors thrown by the client", async () => {
    mockQuery.mockRejectedValueOnce(new Error("timeout"));
    await expect(getAppliedMigrations(client)).rejects.toThrow("timeout");
  });
});

// ─── recordMigration ─────────────────────────────────────────────────────────

describe("recordMigration()", () => {
  it("executes an INSERT INTO schema_migrations", async () => {
    await recordMigration(client, "001", "create_users_table");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql: string = (mockQuery.mock.calls[0] as [string])[0];
    expect(sql).toMatch(/INSERT INTO schema_migrations/i);
  });

  it("passes id and name as parameterized values", async () => {
    await recordMigration(client, "001", "create_users_table");
    const values = (mockQuery.mock.calls[0] as [string, string[]])[1];
    expect(values).toEqual(["001", "create_users_table"]);
  });

  it("uses $1 and $2 placeholders (not string interpolation)", async () => {
    await recordMigration(client, "001", "create_users_table");
    const sql: string = (mockQuery.mock.calls[0] as [string])[0];
    expect(sql).toMatch(/\$1/);
    expect(sql).toMatch(/\$2/);
  });

  it("propagates errors thrown by the client", async () => {
    mockQuery.mockRejectedValueOnce(new Error("unique violation"));
    await expect(recordMigration(client, "001", "x")).rejects.toThrow("unique violation");
  });
});

// ─── removeMigration ─────────────────────────────────────────────────────────

describe("removeMigration()", () => {
  it("executes a DELETE FROM schema_migrations", async () => {
    await removeMigration(client, "001");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql: string = (mockQuery.mock.calls[0] as [string])[0];
    expect(sql).toMatch(/DELETE FROM schema_migrations/i);
  });

  it("filters by id using a parameterized query", async () => {
    await removeMigration(client, "001");
    const [sql, values] = mockQuery.mock.calls[0] as [string, string[]];
    expect(sql).toMatch(/WHERE id = \$1/i);
    expect(values).toEqual(["001"]);
  });

  it("propagates errors thrown by the client", async () => {
    mockQuery.mockRejectedValueOnce(new Error("constraint error"));
    await expect(removeMigration(client, "001")).rejects.toThrow("constraint error");
  });
});
