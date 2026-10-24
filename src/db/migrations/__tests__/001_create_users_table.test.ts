/**
 * Tests for migration 001 — create_users_table
 *
 * Strategy: inject a mock PoolClient directly into migration.up() and
 * migration.down(). No real database connection is needed — the global
 * pg mock (test/mocks/pg.ts) already replaces the pg module, but here we
 * construct a fine-grained mock client so we can assert exact SQL calls
 * and exercise failure paths deterministically.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { migration } from "../001_create_users_table.js";
import type { PoolClient } from "pg";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a mock PoolClient whose query() resolves successfully by default. */
function makeMockClient(
  queryImpl?: (sql: string) => Promise<void>,
): jest.Mocked<Pick<PoolClient, "query" | "release">> {
  return {
    query: jest.fn(queryImpl ?? (() => Promise.resolve({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] }))) as any,
    release: jest.fn(),
  };
}

// ─── Static contract ─────────────────────────────────────────────────────────

describe("migration 001 — create_users_table", () => {
  describe("static contract", () => {
    it("exports id '001'", () => {
      expect(migration.id).toBe("001");
    });

    it("exports name 'create_users_table'", () => {
      expect(migration.name).toBe("create_users_table");
    });

    it("exports an up() function", () => {
      expect(typeof migration.up).toBe("function");
    });

    it("exports a down() function", () => {
      expect(typeof migration.down).toBe("function");
    });
  });

  // ─── up() — success paths ───────────────────────────────────────────────

  describe("up()", () => {
    let client: ReturnType<typeof makeMockClient>;

    beforeEach(() => {
      client = makeMockClient();
    });

    it("issues exactly two queries", async () => {
      await migration.up(client as unknown as PoolClient);
      expect(client.query).toHaveBeenCalledTimes(2);
    });

    it("first query creates the users table", async () => {
      await migration.up(client as unknown as PoolClient);
      const firstCall = (client.query as jest.Mock).mock.calls[0][0] as string;
      expect(firstCall).toMatch(/CREATE\s+TABLE\s+users/i);
    });

    it("users table has a UUID primary key with gen_random_uuid()", async () => {
      await migration.up(client as unknown as PoolClient);
      const firstCall = (client.query as jest.Mock).mock.calls[0][0] as string;
      expect(firstCall).toMatch(/id\s+UUID\s+PRIMARY\s+KEY/i);
      expect(firstCall).toMatch(/gen_random_uuid\(\)/i);
    });

    it("users table has a NOT NULL UNIQUE email column (VARCHAR 320)", async () => {
      await migration.up(client as unknown as PoolClient);
      const firstCall = (client.query as jest.Mock).mock.calls[0][0] as string;
      expect(firstCall).toMatch(/email\s+VARCHAR\(320\)\s+NOT\s+NULL\s+UNIQUE/i);
    });

    it("users table has TIMESTAMPTZ created_at and updated_at columns", async () => {
      await migration.up(client as unknown as PoolClient);
      const firstCall = (client.query as jest.Mock).mock.calls[0][0] as string;
      expect(firstCall).toMatch(/created_at\s+TIMESTAMPTZ/i);
      expect(firstCall).toMatch(/updated_at\s+TIMESTAMPTZ/i);
    });

    it("second query creates idx_users_email index on the email column", async () => {
      await migration.up(client as unknown as PoolClient);
      const secondCall = (client.query as jest.Mock).mock.calls[1][0] as string;
      expect(secondCall).toMatch(/CREATE\s+INDEX\s+idx_users_email\s+ON\s+users\s*\(email\)/i);
    });

    it("resolves without a return value on success", async () => {
      const result = await migration.up(client as unknown as PoolClient);
      expect(result).toBeUndefined();
    });

    // ─── up() — failure paths ──────────────────────────────────────────────

    it("propagates an error thrown by the CREATE TABLE query", async () => {
      const dbError = new Error("duplicate table: users");
      const failClient = makeMockClient(() => Promise.reject(dbError));
      await expect(
        migration.up(failClient as unknown as PoolClient),
      ).rejects.toThrow("duplicate table: users");
    });

    it("propagates an error thrown by the CREATE INDEX query", async () => {
      const dbError = new Error("index already exists: idx_users_email");
      let callCount = 0;
      const failOnSecond = makeMockClient(() => {
        callCount++;
        if (callCount === 2) return Promise.reject(dbError);
        return Promise.resolve({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
      });
      await expect(
        migration.up(failOnSecond as unknown as PoolClient),
      ).rejects.toThrow("index already exists: idx_users_email");
    });

    it("does not call query after a failure (stops on first error)", async () => {
      const dbError = new Error("permission denied");
      let callCount = 0;
      const failClient = makeMockClient(() => {
        callCount++;
        return Promise.reject(dbError);
      });
      await migration.up(failClient as unknown as PoolClient).catch(() => {});
      // Only the first call should have been attempted
      expect(callCount).toBe(1);
    });
  });

  // ─── down() — success paths ─────────────────────────────────────────────

  describe("down()", () => {
    let client: ReturnType<typeof makeMockClient>;

    beforeEach(() => {
      client = makeMockClient();
    });

    it("issues exactly one query", async () => {
      await migration.down(client as unknown as PoolClient);
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it("issues DROP TABLE IF EXISTS users", async () => {
      await migration.down(client as unknown as PoolClient);
      const sql = (client.query as jest.Mock).mock.calls[0][0] as string;
      expect(sql).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+users/i);
    });

    it("resolves without a return value on success", async () => {
      const result = await migration.down(client as unknown as PoolClient);
      expect(result).toBeUndefined();
    });

    it("is safe to call when the table does not exist (IF EXISTS guard)", async () => {
      // The IF EXISTS guard means the SQL should not include a conditional
      // throw from the database. Confirm the query text carries IF EXISTS.
      await migration.down(client as unknown as PoolClient);
      const sql = (client.query as jest.Mock).mock.calls[0][0] as string;
      expect(sql).toMatch(/IF\s+EXISTS/i);
    });

    // ─── down() — failure paths ────────────────────────────────────────────

    it("propagates an error thrown by the DROP TABLE query", async () => {
      const dbError = new Error("permission denied for table users");
      const failClient = makeMockClient(() => Promise.reject(dbError));
      await expect(
        migration.down(failClient as unknown as PoolClient),
      ).rejects.toThrow("permission denied for table users");
    });
  });

  // ─── round-trip state transitions ───────────────────────────────────────

  describe("round-trip (up → down)", () => {
    it("up then down calls query four times total", async () => {
      const client = makeMockClient();
      await migration.up(client as unknown as PoolClient);
      await migration.down(client as unknown as PoolClient);
      // up: CREATE TABLE + CREATE INDEX = 2 calls
      // down: DROP TABLE IF EXISTS      = 1 call
      expect(client.query).toHaveBeenCalledTimes(3);
    });

    it("up then down produces the expected SQL sequence", async () => {
      const client = makeMockClient();
      await migration.up(client as unknown as PoolClient);
      await migration.down(client as unknown as PoolClient);

      const calls = (client.query as jest.Mock).mock.calls.map(
        (c) => (c[0] as string).trim(),
      );

      expect(calls[0]).toMatch(/CREATE\s+TABLE\s+users/i);
      expect(calls[1]).toMatch(/CREATE\s+INDEX\s+idx_users_email/i);
      expect(calls[2]).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+users/i);
    });
  });

  // ─── Migration interface conformance ────────────────────────────────────

  describe("Migration interface conformance", () => {
    it("id is a non-empty string", () => {
      expect(typeof migration.id).toBe("string");
      expect(migration.id.trim().length).toBeGreaterThan(0);
    });

    it("name is a non-empty string", () => {
      expect(typeof migration.name).toBe("string");
      expect(migration.name.trim().length).toBeGreaterThan(0);
    });

    it("name uses snake_case convention", () => {
      expect(migration.name).toMatch(/^[a-z0-9_]+$/);
    });

    it("up is an async function (returns a Promise)", () => {
      const client = makeMockClient();
      const result = migration.up(client as unknown as PoolClient);
      expect(result).toBeInstanceOf(Promise);
      // Clean up the floating promise
      return result;
    });

    it("down is an async function (returns a Promise)", () => {
      const client = makeMockClient();
      const result = migration.down(client as unknown as PoolClient);
      expect(result).toBeInstanceOf(Promise);
      return result;
    });
  });
});
