/**
 * Focused behavior coverage for
 * src/db/migrations/009_create_legal_holds.ts.
 *
 * Asserts the idempotent table/index creation contract, the documented column
 * shapes, the teardown and failure propagation.
 */

import { describe, it, expect } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../009_create_legal_holds.js";

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

describe("migration 009 create_legal_holds", () => {
  describe("registry contract", () => {
    it("exposes the id/name consumed by the migration registry", () => {
      expect(migration.id).toBe("011");
      expect(migration.name).toBe("create_legal_holds");
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });
  });

  describe("up()", () => {
    it("creates the legal_holds table idempotently", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toContain("CREATE TABLE IF NOT EXISTS legal_holds");
    });

    it("declares the documented columns and their constraints", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
      expect(text).toMatch(/subject_id VARCHAR\(255\) NOT NULL/);
      expect(text).toMatch(/actor VARCHAR\(255\) NOT NULL/);
      expect(text).toMatch(/reason TEXT NOT NULL/);
      expect(text).toMatch(/region VARCHAR\(50\) NOT NULL/);
      expect(text).toMatch(/created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW\(\)/);
    });

    it("indexes the subject lookup path idempotently", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toContain("CREATE INDEX IF NOT EXISTS idx_legal_holds_subject_id ON legal_holds(subject_id)");
    });

    it("issues the table before its index and leaves no data-destructive statements", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);

      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS legal_holds");
      expect(statements[1]).toContain("idx_legal_holds_subject_id");
      expect(sqlText(statements)).not.toMatch(/DROP/);
    });
  });

  describe("down()", () => {
    it("drops the table idempotently so repeated rollbacks are safe", async () => {
      const { client, statements } = createFakeClient();
      await migration.down(client);

      expect(statements).toEqual(["DROP TABLE IF EXISTS legal_holds"]);
    });
  });

  describe("failure handling", () => {
    it("propagates an up() failure and stops on the first failing statement", async () => {
      const { client, statements } = createFakeClient(1);
      await expect(migration.up(client)).rejects.toThrow("connection reset by peer");
      expect(statements).toHaveLength(1);
    });

    it("propagates a down() failure to the caller", async () => {
      const { client } = createFakeClient(1);
      await expect(migration.down(client)).rejects.toThrow("connection reset by peer");
    });
  });
});
