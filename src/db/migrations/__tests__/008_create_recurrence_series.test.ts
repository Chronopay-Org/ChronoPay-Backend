import { describe, expect, it, jest } from "@jest/globals";
import type { PoolClient } from "pg";

import { migration } from "../008_create_recurrence_series.js";

/**
 * Behaviour coverage for migration 008_create_recurrence_series.
 *
 * Migration 008 is pure DDL orchestration: it issues a fixed, unparameterised
 * sequence of `CREATE TABLE` / `CREATE INDEX` statements in `up()` and a
 * dependency-ordered pair of `DROP TABLE` statements in `down()`. The only
 * meaningful public behaviour is therefore:
 *
 *   1. the exact schema contract (tables, constraints, foreign key, indexes),
 *   2. the ordering invariant that the FK child is created after — and dropped
 *      before — the parent it references, and
 *   3. deterministic, observable error propagation so a failure never leaves
 *      the caller guessing whether the remaining statements ran.
 *
 * A recording fake for `PoolClient` captures each statement and its arguments.
 * No live database is required: the statements are asserted directly, which
 * keeps the suite fast and fully deterministic. (`pg` is stubbed by Jest via
 * `jest.config.cjs`, and this test imports the type only, so it is erased at
 * compile time.)
 */

interface RecordedQuery {
  sql: string;
  values: unknown[] | undefined;
}

/**
 * Returns a `PoolClient` double that records every query issued against it.
 * The returned `query` mock is the same function the migration calls, so tests
 * can assert both the recorded SQL and the call count.
 */
function fakeClient() {
  const calls: RecordedQuery[] = [];

  const query = jest.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    return { rows: [], rowCount: null, command: "DDL", oid: 0, fields: [] };
  });

  return {
    client: { query } as unknown as PoolClient,
    query,
    calls,
    statements: () => calls.map((call) => call.sql),
  };
}

/** Collapses SQL whitespace so multi-line DDL can be matched as one string. */
function collapse(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

describe("migration 008_create_recurrence_series", () => {
  describe("migration contract", () => {
    it("keeps its registry id and name stable", () => {
      expect(migration.id).toBe("010");
      expect(migration.name).toBe("create_recurrence_series");
    });

    it("exposes up() and down() as callable hooks", () => {
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });
  });

  describe("up()", () => {
    it("creates both tables before any index, in a deterministic order", async () => {
      const { client, statements } = fakeClient();

      await migration.up(client);

      const sql = statements();
      expect(sql).toHaveLength(5);
      expect(collapse(sql[0])).toContain("CREATE TABLE recurrence_series");
      expect(collapse(sql[1])).toContain("CREATE TABLE materialized_occurrences");

      // Every index must target a table that already exists by this point.
      const indexes = sql.slice(2);
      expect(indexes).toHaveLength(3);
      expect(indexes.every((s) => s.includes("CREATE INDEX"))).toBe(true);
      expect(
        indexes.every((s) => s.includes("materialized_occurrences")),
      ).toBe(true);
    });

    it("defines recurrence_series with a positive-version guard", async () => {
      const { client, statements } = fakeClient();

      await migration.up(client);

      const ddl = collapse(statements()[0]);
      expect(ddl).toContain("id UUID PRIMARY KEY DEFAULT gen_random_uuid()");
      expect(ddl).toContain("rrule TEXT NOT NULL");
      expect(ddl).toContain("version INTEGER NOT NULL DEFAULT 1");
      expect(ddl).toContain("created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      expect(ddl).toContain("updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      expect(ddl).toContain(
        "CONSTRAINT chk_recurrence_series_version_positive CHECK (version > 0)",
      );
    });

    it("defines materialized_occurrences with a cascading FK and positive-version guard", async () => {
      const { client, statements } = fakeClient();

      await migration.up(client);

      const ddl = collapse(statements()[1]);
      expect(ddl).toContain(
        "series_id UUID NOT NULL REFERENCES recurrence_series(id) ON DELETE CASCADE",
      );
      expect(ddl).toContain("series_version INTEGER NOT NULL");
      expect(ddl).toContain("occurrence_date TIMESTAMPTZ NOT NULL");
      expect(ddl).toContain("materialized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      expect(ddl).toContain(
        "CONSTRAINT chk_materialized_occurrences_version_positive CHECK (series_version > 0)",
      );
    });

    it("creates the three supporting indexes with their documented column order", async () => {
      const { client, statements } = fakeClient();

      await migration.up(client);

      const indexes = statements().slice(2).map(collapse).join("\n");
      expect(indexes).toContain(
        "CREATE INDEX idx_materialized_occurrences_series_version ON materialized_occurrences (series_id, series_version DESC, occurrence_date)",
      );
      expect(indexes).toContain(
        "CREATE INDEX idx_materialized_occurrences_date ON materialized_occurrences (occurrence_date)",
      );
      expect(indexes).toContain(
        "CREATE INDEX idx_materialized_occurrences_series_version_cleanup ON materialized_occurrences (series_id, series_version)",
      );
    });

    it("issues unparameterised DDL only", async () => {
      const { client, calls } = fakeClient();

      await migration.up(client);

      expect(calls.every((call) => call.values === undefined)).toBe(true);
    });

    it("never issues destructive statements on the forward path", async () => {
      const { client, statements } = fakeClient();

      await migration.up(client);

      // Every forward statement must be additive. Note: a naive /DROP|DELETE/
      // match would false-positive on the FK's `ON DELETE CASCADE` action, so
      // assert at statement level instead.
      expect(statements().every((s) => collapse(s).startsWith("CREATE "))).toBe(
        true,
      );
    });

    it("propagates the first failure and stops issuing further statements", async () => {
      const failure = new Error("permission denied for schema public");
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(failure);
      const client = { query } as unknown as PoolClient;

      await expect(migration.up(client)).rejects.toBe(failure);
      expect(query).toHaveBeenCalledTimes(2);
    });

    it("surfaces non-Error rejections unchanged", async () => {
      const query = jest.fn().mockRejectedValueOnce("connection reset");
      const client = { query } as unknown as PoolClient;

      await expect(migration.up(client)).rejects.toBe("connection reset");
      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  describe("down()", () => {
    it("drops the dependent table before the referenced table", async () => {
      const { client, query, statements } = fakeClient();

      await migration.down(client);

      expect(query).toHaveBeenCalledTimes(2);
      const sql = statements();
      expect(collapse(sql[0])).toContain(
        "DROP TABLE IF EXISTS materialized_occurrences",
      );
      expect(collapse(sql[1])).toContain(
        "DROP TABLE IF EXISTS recurrence_series",
      );

      const childIndex = statements().findIndex((s) =>
        s.includes("materialized_occurrences"),
      );
      const parentIndex = statements().findIndex((s) =>
        s.includes("recurrence_series"),
      );
      expect(childIndex).toBeLessThan(parentIndex);
    });

    it("only issues IF EXISTS drops so rollback is safe to retry", async () => {
      const { client, statements } = fakeClient();

      await migration.down(client);

      expect(
        statements().every((s) => /DROP TABLE IF EXISTS/.test(s)),
      ).toBe(true);
    });

    it("does not attempt the second drop when the first fails", async () => {
      const failure = new Error("database is locked");
      const query = jest.fn().mockRejectedValueOnce(failure);
      const client = { query } as unknown as PoolClient;

      await expect(migration.down(client)).rejects.toBe(failure);
      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  describe("up() → down() state transition", () => {
    it("creates then removes exactly the objects it created", async () => {
      const { client, statements } = fakeClient();

      await migration.up(client);
      await migration.down(client);

      const sql = statements();
      expect(sql).toHaveLength(7);
      expect(sql.slice(0, 5).every((s) => s.includes("CREATE"))).toBe(true);
      expect(collapse(sql[5])).toContain(
        "DROP TABLE IF EXISTS materialized_occurrences",
      );
      expect(collapse(sql[6])).toContain(
        "DROP TABLE IF EXISTS recurrence_series",
      );
    });

    it("does not retain the parent table after the child is dropped", async () => {
      const { client, statements } = fakeClient();

      await migration.up(client);
      await migration.down(client);

      // Both tables must be gone, otherwise the FK in materialized_occurrences
      // would keep recurrence_series undeletable.
      const rollback = statements().slice(5).join(" ");
      expect(rollback).toContain("materialized_occurrences");
      expect(rollback).toContain("recurrence_series");
    });
  });
});
