/**
 * Focused behavior coverage for
 * src/db/migrations/014_add_reputation_bootstrap_columns.ts.
 *
 * Asserts the additive (IF NOT EXISTS) column contract, the partial bootstrap
 * index predicate, the reverse-order teardown and failure propagation.
 */

import { describe, it, expect } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../014_add_reputation_bootstrap_columns.js";

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

describe("migration 014 add_reputation_bootstrap_columns", () => {
  describe("registry contract", () => {
    it("exposes the id/name consumed by the migration registry", () => {
      expect(migration.id).toBe("018");
      expect(migration.name).toBe("add_reputation_bootstrap_columns");
    });
  });

  describe("up()", () => {
    it("adds every bootstrap column to users additively", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toContain("ALTER TABLE users");

      const columns = [
        "region",
        "reputation_bootstrap_granted",
        "reputation_bootstrap_granted_at",
        "reputation_bootstrap_expires_at",
        "reputation_bootstrap_consumed",
        "reputation_bootstrap_consumed_at",
        "reputation_bootstrap_score",
      ];
      for (const column of columns) {
        expect(text).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`));
      }
    });

    it("declares the declared types and safe defaults", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(/region VARCHAR\(64\)/);
      expect(text).toMatch(/reputation_bootstrap_granted BOOLEAN NOT NULL DEFAULT FALSE/);
      expect(text).toMatch(/reputation_bootstrap_consumed BOOLEAN NOT NULL DEFAULT FALSE/);
      expect(text).toMatch(/reputation_bootstrap_score NUMERIC\(5,2\)/);
      expect(text).toMatch(/reputation_bootstrap_granted_at TIMESTAMPTZ/);
      expect(text).toMatch(/reputation_bootstrap_expires_at TIMESTAMPTZ/);
    });

    it("creates a partial index that only covers unconsumed active grants", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(
        /CREATE INDEX IF NOT EXISTS idx_users_bootstrap_expires_at ON users \(reputation_bootstrap_expires_at\) WHERE reputation_bootstrap_granted = TRUE AND reputation_bootstrap_consumed = FALSE/,
      );
    });

    it("never drops or rewrites existing user data while adding columns", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).not.toMatch(/DROP COLUMN/);
      expect(text).not.toMatch(/DROP TABLE/);
      expect(text).not.toMatch(/DROP INDEX/);
    });

    it("runs the ALTER before the index in a single up() pass", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);

      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("ALTER TABLE users");
      expect(statements[1]).toContain("CREATE INDEX IF NOT EXISTS idx_users_bootstrap_expires_at");
    });
  });

  describe("down()", () => {
    it("drops the index first and then every column in reverse order", async () => {
      const { client, statements } = createFakeClient();
      await migration.down(client);

      expect(statements).toHaveLength(2);
      expect(statements[0]).toBe("DROP INDEX IF EXISTS idx_users_bootstrap_expires_at");

      const drop = statements[1];
      expect(drop).toContain("ALTER TABLE users");
      const order = [
        "reputation_bootstrap_score",
        "reputation_bootstrap_consumed_at",
        "reputation_bootstrap_consumed",
        "reputation_bootstrap_expires_at",
        "reputation_bootstrap_granted_at",
        "reputation_bootstrap_granted",
        "region",
      ];
      let cursor = -1;
      for (const column of order) {
        const at = drop.indexOf(`DROP COLUMN IF EXISTS ${column}`);
        expect(at).toBeGreaterThan(cursor);
        cursor = at;
      }
    });
  });

  describe("failure handling", () => {
    it("propagates an up() failure and stops on the first failing statement", async () => {
      const { client, statements } = createFakeClient(1);
      await expect(migration.up(client)).rejects.toThrow("connection reset by peer");
      expect(statements).toHaveLength(1);
    });

    it("propagates a down() failure to the caller", async () => {
      const { client } = createFakeClient(2);
      await expect(migration.down(client)).rejects.toThrow("connection reset by peer");
    });
  });
});
