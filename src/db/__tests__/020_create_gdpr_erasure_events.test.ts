/**
 * 020_create_gdpr_erasure_events.test.ts
 *
 * Focused behavior coverage for the `gdpr_erasure_events` migration (Issue #1061).
 *
 * The migration is pure SQL orchestration, so the observable contract is:
 *   - the exact statements emitted, in a deterministic order;
 *   - the table shape that makes an erasure receipt self-contained and auditable
 *     (UUID identifiers, JSONB receipt, dry-run flag) plus the deliberate
 *     absence of a FK to `users`;
 *   - the partial index used to separate dry-run previews from live runs;
 *   - stop-on-first-failure error propagation for both `up()` and `down()`.
 */

import { describe, it, expect, jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../migrations/020_create_gdpr_erasure_events.js";

// ─── Fakes & helpers ──────────────────────────────────────────────────────────

interface QuerySpy {
  client: PoolClient;
  /** Normalised SQL text (whitespace collapsed) plus the bound params. */
  queries: Array<{ sql: string; params: unknown[] }>;
}

/** Collapses the template-literal formatting so assertions read as one line. */
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
    return { rows: [], rowCount: null, command: "CREATE", oid: 0, fields: [] };
  });
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  return { client, queries };
}

function sqlList(queries: QuerySpy["queries"]): string[] {
  return queries.map((q) => q.sql);
}

function findStatement(queries: QuerySpy["queries"], pattern: RegExp): string {
  const match = queries.find((q) => pattern.test(q.sql));
  if (!match) {
    throw new Error(
      `No statement matched ${pattern}.\nEmitted:\n${sqlList(queries).join("\n")}`,
    );
  }
  return match.sql;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("migration 020 — create_gdpr_erasure_events", () => {
  describe("definition", () => {
    it("exposes the migration contract with a stable id/name", () => {
      expect(migration.id).toBe("020");
      expect(migration.name).toBe("create_gdpr_erasure_events");
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });
  });

  describe("up()", () => {
    it("creates the table and three indexes in order", async () => {
      const { client, queries } = makeClient();

      await migration.up(client);

      expect(queries).toHaveLength(4);
      const [table, subjectIdx, erasedAtIdx, dryRunIdx] = sqlList(queries);

      expect(table).toMatch(
        /^CREATE TABLE IF NOT EXISTS gdpr_erasure_events \(/,
      );
      expect(subjectIdx).toMatch(
        /^CREATE INDEX idx_gdpr_erasure_events_subject_id ON gdpr_erasure_events \(subject_id\)/,
      );
      expect(erasedAtIdx).toMatch(
        /^CREATE INDEX idx_gdpr_erasure_events_erased_at ON gdpr_erasure_events \(erased_at DESC\)/,
      );
      expect(dryRunIdx).toMatch(
        /^CREATE INDEX idx_gdpr_erasure_events_dry_run ON gdpr_erasure_events \(dry_run\)/,
      );
    });

    it("declares a self-contained, auditable receipt row", async () => {
      const { client, queries } = makeClient();

      await migration.up(client);

      const table = findStatement(
        queries,
        /^CREATE TABLE IF NOT EXISTS gdpr_erasure_events/,
      );

      expect(table).toContain("id UUID PRIMARY KEY DEFAULT gen_random_uuid()");
      expect(table).toContain("receipt_id UUID NOT NULL UNIQUE");
      expect(table).toContain("subject_id TEXT NOT NULL");
      expect(table).toContain("erased_at TIMESTAMPTZ NOT NULL");
      expect(table).toContain("receipt JSONB NOT NULL");
      expect(table).toContain("dry_run BOOLEAN NOT NULL DEFAULT FALSE");
      expect(table).toContain("requested_by TEXT NOT NULL");
      expect(table).toContain("created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    });

    it("keeps the event row independent of the erased user record (no foreign key)", async () => {
      const { client, queries } = makeClient();

      await migration.up(client);

      const table = findStatement(
        queries,
        /^CREATE TABLE IF NOT EXISTS gdpr_erasure_events/,
      );

      // A FK would be cascaded away by the very erasure the row documents.
      expect(table).not.toContain("REFERENCES");
      expect(table).toContain("subject_id TEXT NOT NULL");
    });

    it("is re-runnable: the table creation is guarded by IF NOT EXISTS", async () => {
      const { client, queries } = makeClient();

      await migration.up(client);
      await migration.up(client);

      const tableStatements = sqlList(queries).filter((sql) =>
        sql.startsWith("CREATE TABLE"),
      );
      expect(tableStatements).toHaveLength(2);
      expect(
        tableStatements.every((sql) =>
          sql.startsWith("CREATE TABLE IF NOT EXISTS gdpr_erasure_events"),
        ),
      ).toBe(true);
    });

    it("scopes the dry-run index to live runs only", async () => {
      const { client, queries } = makeClient();

      await migration.up(client);

      const dryRunIdx = findStatement(
        queries,
        /^CREATE INDEX idx_gdpr_erasure_events_dry_run/,
      );
      expect(dryRunIdx).toContain("WHERE dry_run = FALSE");

      // The other two indexes are unconditional.
      const unconditional = sqlList(queries).filter(
        (sql) =>
          sql.startsWith("CREATE INDEX") &&
          !sql.includes("idx_gdpr_erasure_events_dry_run"),
      );
      expect(unconditional).toHaveLength(2);
      expect(unconditional.every((sql) => !sql.includes("WHERE"))).toBe(true);
    });

    it("binds no parameters, so emitted SQL is deterministic", async () => {
      const { client, queries } = makeClient();

      await migration.up(client);

      expect(queries.every((q) => q.params.length === 0)).toBe(true);
    });

    it("emits an identical statement sequence on repeated runs", async () => {
      const first = makeClient();
      const second = makeClient();

      await migration.up(first.client);
      await migration.up(second.client);

      expect(sqlList(second.queries)).toEqual(sqlList(first.queries));
    });
  });

  describe("failure paths", () => {
    it("surfaces the original error when the table creation is rejected", async () => {
      const failure = new Error("permission denied for schema public");
      const query = jest.fn(async () => {
        throw failure;
      });
      const client = { query, release: jest.fn() } as unknown as PoolClient;

      await expect(migration.up(client)).rejects.toBe(failure);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("stops at the first failing index instead of continuing the run", async () => {
      const { client, queries } = makeClient({
        failOn: /idx_gdpr_erasure_events_erased_at/,
      });

      await expect(migration.up(client)).rejects.toThrow(
        "boom: statement rejected by the database",
      );

      // table + subject index succeeded; the failing index is the last attempt.
      expect(queries).toHaveLength(3);
      expect(
        sqlList(queries).some((sql) =>
          sql.includes("idx_gdpr_erasure_events_dry_run"),
        ),
      ).toBe(false);
    });
  });

  describe("down()", () => {
    it("drops the table idempotently", async () => {
      const { client, queries } = makeClient();

      await migration.down(client);

      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toBe("DROP TABLE IF EXISTS gdpr_erasure_events");
      expect(queries[0].params).toHaveLength(0);
    });

    it("propagates rollback failures", async () => {
      const failure = new Error("cannot drop table: dependent objects");
      const query = jest.fn(async () => {
        throw failure;
      });
      const client = { query, release: jest.fn() } as unknown as PoolClient;

      await expect(migration.down(client)).rejects.toBe(failure);
    });
  });
});
