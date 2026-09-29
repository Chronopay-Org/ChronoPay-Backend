/**
 * Focused behavior coverage for
 * src/db/migrations/015_create_reputation_snapshots.ts.
 *
 * Asserts the table creation, unique constraint on (supplier_id, snapshot_date),
 * index definitions, immutable snapshot design, and rollback behavior.
 */

import { describe, it, expect } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../015_create_reputation_snapshots.js";

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

describe("migration 015 create_reputation_snapshots", () => {
  describe("registry contract", () => {
    it("exposes the id/name consumed by the migration registry", () => {
      expect(migration.id).toBe("021");
      expect(migration.name).toBe("create_reputation_snapshots");
    });
  });

  describe("up()", () => {
    it("creates the reputation_snapshots table with all required columns", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toContain("CREATE TABLE reputation_snapshots");

      const columns = [
        "id UUID PRIMARY KEY DEFAULT gen_random_uuid()",
        "supplier_id TEXT NOT NULL",
        "snapshot_date DATE NOT NULL",
        "score NUMERIC(10, 4) NOT NULL",
        "tier_label TEXT NOT NULL",
        "tier_boundaries JSONB NOT NULL",
        "job_run_id TEXT NOT NULL",
        "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
      ];

      for (const column of columns) {
        const pattern = column.replace(/[()]/g, "\\$&");
        expect(text).toMatch(new RegExp(pattern));
      }
    });

    it("creates a unique index on (supplier_id, snapshot_date) for idempotency", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(
        /CREATE UNIQUE INDEX idx_reputation_snapshots_supplier_date ON reputation_snapshots \(supplier_id, snapshot_date\)/,
      );
    });

    it("creates a descending index on snapshot_date for time-series queries", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(
        /CREATE INDEX idx_reputation_snapshots_date ON reputation_snapshots \(snapshot_date DESC\)/,
      );
    });

    it("executes table creation before index creation", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);

      expect(statements).toHaveLength(3);
      expect(statements[0]).toContain("CREATE TABLE reputation_snapshots");
      expect(statements[1]).toContain("CREATE UNIQUE INDEX idx_reputation_snapshots_supplier_date");
      expect(statements[2]).toContain("CREATE INDEX idx_reputation_snapshots_date");
    });

    it("uses NUMERIC(10, 4) for score precision", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(/score NUMERIC\(10, 4\) NOT NULL/);
    });

    it("stores tier_boundaries as JSONB for flexible tier configuration", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(/tier_boundaries JSONB NOT NULL/);
    });

    it("uses DATE type for snapshot_date without time component", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(/snapshot_date DATE NOT NULL/);
    });
  });

  describe("down()", () => {
    it("drops the reputation_snapshots table with IF EXISTS guard", async () => {
      const { client, statements } = createFakeClient();
      await migration.down(client);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toBe("DROP TABLE IF EXISTS reputation_snapshots");
    });

    it("implicitly drops all indexes when dropping the table", async () => {
      const { client, statements } = createFakeClient();
      await migration.down(client);

      // Verify no separate DROP INDEX statements
      const text = sqlText(statements);
      expect(text).not.toContain("DROP INDEX");
      expect(text).toContain("DROP TABLE");
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

    it("fails gracefully when table creation is interrupted mid-up", async () => {
      const { client, statements } = createFakeClient(2);
      await expect(migration.up(client)).rejects.toThrow("connection reset by peer");
      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("CREATE TABLE");
      expect(statements[1]).toContain("CREATE UNIQUE INDEX");
    });
  });

  describe("data integrity constraints", () => {
    it("enforces NOT NULL on all critical columns except id", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      const requiredFields = [
        "supplier_id TEXT NOT NULL",
        "snapshot_date DATE NOT NULL",
        "score NUMERIC(10, 4) NOT NULL",
        "tier_label TEXT NOT NULL",
        "tier_boundaries JSONB NOT NULL",
        "job_run_id TEXT NOT NULL",
        "created_at TIMESTAMPTZ NOT NULL",
      ];

      for (const field of requiredFields) {
        expect(text).toContain(field);
      }
    });

    it("provides automatic UUID generation for primary key", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    });

    it("provides automatic timestamp for created_at", async () => {
      const { client, statements } = createFakeClient();
      await migration.up(client);
      const text = sqlText(statements);

      expect(text).toMatch(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
    });
  });
});
