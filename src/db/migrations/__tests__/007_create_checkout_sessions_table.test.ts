/**
 * Focused behavior coverage for
 * src/db/migrations/007_create_checkout_sessions_table.ts.
 *
 * Asserts the enum/table/index creation contract, the teardown order and the
 * failure semantics against a deterministic in-memory PoolClient.
 */

import { describe, it, expect } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../007_create_checkout_sessions_table.js";

type FakeQueryResult = { rows: unknown[]; rowCount: number };

function createFakeClient(failOnCall?: number) {
  const statements: string[] = [];
  const query = async (sql: string): Promise<FakeQueryResult> => {
    const index = statements.length + 1;
    statements.push(sql.replace(/\s+/g, " ").trim());
    if (failOnCall === index) {
      throw new Error("connection reset by peer");
    }
    return { rows: [], rowCount: 0 };
  };
  return { client: { query } as unknown as PoolClient, statements };
}

const sqlText = (statements: string[]): string => statements.join("\n");

describe("migration 007 create_checkout_sessions_table", () => {
  describe("registry contract", () => {
    it("exposes the id/name consumed by the migration registry", () => {
      expect(migration.id).toBe("008");
      expect(migration.name).toBe("create_checkout_sessions_table");
    });
  });

  describe("up()", () => {
    it("creates the checkout_session_status enum with every allowed state", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(/CREATE TYPE checkout_session_status AS ENUM/);
      for (const status of ["pending", "completed", "failed", "expired", "cancelled"]) {
        expect(text).toContain(`'${status}'`);
      }
    });

    it("creates the checkout_sessions table with required columns and defaults", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toContain("CREATE TABLE checkout_sessions");
      for (const column of [
        "id",
        "payment",
        "customer",
        "status",
        "metadata",
        "success_url",
        "cancel_url",
        "payment_token",
        "created_at",
        "updated_at",
        "expires_at",
      ]) {
        expect(text).toMatch(new RegExp(`\\b${column}\\b`));
      }

      expect(text).toMatch(/id\s+UUID\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
      expect(text).toMatch(/payment\s+JSONB\s+NOT NULL/);
      expect(text).toMatch(/customer\s+JSONB\s+NOT NULL/);
      expect(text).toMatch(/status\s+checkout_session_status\s+NOT NULL DEFAULT 'pending'/);
      expect(text).toMatch(/expires_at\s+TIMESTAMPTZ\s+NOT NULL/);
    });

    it("keeps the JSONB columns and nullable URLs open for forward-compatible payloads", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(/metadata\s+JSONB,/);
      expect(text).toMatch(/success_url\s+TEXT,/);
      expect(text).toMatch(/cancel_url\s+TEXT,/);
      expect(text).toMatch(/payment_token\s+TEXT,/);
    });

    it("indexes both the TTL cleanup and status lookup paths", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toContain("CREATE INDEX idx_checkout_sessions_expires_at ON checkout_sessions (expires_at)");
      expect(text).toContain("CREATE INDEX idx_checkout_sessions_status ON checkout_sessions (status)");
    });

    it("issues the enum, table and both indexes in a deterministic order", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);

      expect(statements).toHaveLength(4);
      expect(statements[0]).toContain("CREATE TYPE checkout_session_status");
      expect(statements[1]).toContain("CREATE TABLE checkout_sessions");
      expect(statements[2]).toContain("idx_checkout_sessions_expires_at");
      expect(statements[3]).toContain("idx_checkout_sessions_status");
    });
  });

  describe("down()", () => {
    it("drops the table before the enum so the teardown is idempotent", async () => {
      const { client, statements } = createFakeClient();
      await migration.down(client);

      expect(statements).toEqual([
        "DROP TABLE IF EXISTS checkout_sessions",
        "DROP TYPE IF EXISTS checkout_session_status",
      ]);
    });
  });

  describe("failure handling", () => {
    it("propagates an up() failure and stops on the first failing statement", async () => {
      const { client, statements } = createFakeClient(2);
      await expect(migration.up(client)).rejects.toThrow("connection reset by peer");
      expect(statements).toHaveLength(2);
    });

    it("propagates a down() failure to the caller", async () => {
      const { client } = createFakeClient(1);
      await expect(migration.down(client)).rejects.toThrow("connection reset by peer");
    });
  });
});
