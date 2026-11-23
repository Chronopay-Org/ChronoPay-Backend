/**
 * 018_create_dispute_mediation_transcripts.test.ts
 *
 * Focused behavior coverage for the `dispute_mediation_transcripts` migration
 * (Issue #1057).
 *
 * The migration is pure SQL orchestration, so the observable contract is:
 *   - the exact statements emitted, in a deterministic order;
 *   - the schema constraints / partial-index predicates encoded in them;
 *   - the retention-window CASE mapping (override ms > jurisdiction > 7yr default);
 *   - stop-on-first-failure error propagation for both `up()` and `down()`.
 */

import { describe, it, expect, jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../migrations/018_create_dispute_mediation_transcripts.js";

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

describe("migration 018 — create_dispute_mediation_transcripts", () => {
  describe("definition", () => {
    it("exposes the migration contract with a stable id/name", () => {
      expect(migration.id).toBe("018");
      expect(migration.name).toBe("create_dispute_mediation_transcripts");
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });
  });

  describe("up()", () => {
    it("creates the table, three indexes, and the retention comment in order", async () => {
      const { client, queries } = makeClient();

      await migration.up(client);

      expect(queries).toHaveLength(5);
      const [table, disputeIdx, kekIdx, retentionIdx, comment] =
        sqlList(queries);

      expect(table).toMatch(
        /^CREATE TABLE dispute_mediation_transcripts \(/,
      );
      expect(disputeIdx).toMatch(
        /^CREATE INDEX idx_dispute_transcripts_dispute_id_created ON dispute_mediation_transcripts \(dispute_id, created_at\)/,
      );
      expect(kekIdx).toMatch(
        /^CREATE INDEX idx_dispute_transcripts_kek_version ON dispute_mediation_transcripts \(kek_version_id\)/,
      );
      expect(retentionIdx).toMatch(
        /^CREATE INDEX idx_dispute_transcripts_retention_close ON dispute_mediation_transcripts \(/,
      );
      expect(comment).toMatch(
        /^COMMENT ON TABLE dispute_mediation_transcripts IS/,
      );
    });

    it("declares the envelope-encryption and retention column constraints", async () => {
      const { client, queries } = makeClient();

      await migration.up(client);

      const table = findStatement(
        queries,
        /^CREATE TABLE dispute_mediation_transcripts/,
      );

      // Identity + ownership
      expect(table).toContain("id TEXT PRIMARY KEY");
      expect(table).toContain("dispute_id TEXT NOT NULL");
      expect(table).toContain("participant_id TEXT NOT NULL");

      // Enumerated boundaries
      expect(table).toContain(
        "kind TEXT NOT NULL CHECK (kind IN ('chat','voice','evidence_excerpt','mediator_note'))",
      );
      expect(table).toContain(
        "participant_role TEXT NOT NULL CHECK (participant_role IN ('buyer','supplier','mediator','senior_arbiter','observer','automation'))",
      );

      // Per-segment DEK material with exact nonce/tag sizes
      expect(table).toContain("ciphertext BYTEA NOT NULL");
      expect(table).toContain(
        "gcm_nonce BYTEA NOT NULL CHECK (octet_length(gcm_nonce) = 12)",
      );
      expect(table).toContain(
        "gcm_tag BYTEA NOT NULL CHECK (octet_length(gcm_tag) = 16)",
      );
      expect(table).toContain("wrapped_dek BYTEA NOT NULL");
      expect(table).toContain("kek_version_id TEXT NOT NULL");
      expect(table).toContain("body_sha256 TEXT NOT NULL");

      // Retention state machine + override columns
      expect(table).toContain("authored_at TIMESTAMPTZ");
      expect(table).toContain("created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      expect(table).toContain("retention_override_jurisdiction TEXT");
      expect(table).toContain("retention_override_ms BIGINT");
      expect(table).toContain(
        "retention_status TEXT NOT NULL DEFAULT 'active' CHECK (retention_status IN ('active','retain_pending_purge','purged'))",
      );
      expect(table).toContain("purged_at TIMESTAMPTZ");
    });

    it("scopes the lookup indexes to non-purged rows", async () => {
      const { client, queries } = makeClient();

      await migration.up(client);

      const disputeIdx = findStatement(
        queries,
        /idx_dispute_transcripts_dispute_id_created/,
      );
      const kekIdx = findStatement(
        queries,
        /idx_dispute_transcripts_kek_version/,
      );

      expect(disputeIdx).toContain("WHERE retention_status != 'purged'");
      expect(kekIdx).toContain("WHERE retention_status != 'purged'");
    });

    it("maps each retention jurisdiction to its close window, with ms override taking precedence", async () => {
      const { client, queries } = makeClient();

      await migration.up(client);

      const retentionIdx = findStatement(
        queries,
        /idx_dispute_transcripts_retention_close/,
      );

      expect(retentionIdx).toContain("COALESCE(");
      expect(retentionIdx).toContain("WHEN retention_override_ms IS NOT NULL");
      expect(retentionIdx).toContain(
        "(retention_override_ms::text || ' ms')::interval",
      );
      expect(retentionIdx).toContain(
        "WHEN retention_override_jurisdiction = 'gdpr-default' THEN created_at + interval '3 years'",
      );
      expect(retentionIdx).toContain(
        "WHEN retention_override_jurisdiction = 'finra-us' THEN created_at + interval '10 years'",
      );
      expect(retentionIdx).toContain(
        "WHEN retention_override_jurisdiction = 'fca-uk' THEN created_at + interval '6 years'",
      );
      expect(retentionIdx).toContain("ELSE created_at + interval '7 years'");
      // COALESCE fallback keeps the 7-year default when the CASE yields NULL.
      expect(retentionIdx.match(/interval '7 years'/g)).toHaveLength(2);
      // Only active rows are scheduled; purged/pending rows drop out of the index.
      expect(retentionIdx).toContain("WHERE retention_status = 'active'");

      // Precedence is encoded by CASE branch order.
      expect(retentionIdx.indexOf("retention_override_ms IS NOT NULL")).toBeLessThan(
        retentionIdx.indexOf("'gdpr-default'"),
      );
      expect(retentionIdx.indexOf("'gdpr-default'")).toBeLessThan(
        retentionIdx.indexOf("ELSE created_at"),
      );
    });

    it("documents the 7-year default retention in the table comment", async () => {
      const { client, queries } = makeClient();

      await migration.up(client);

      const comment = findStatement(queries, /^COMMENT ON TABLE/);
      expect(comment).toContain("Envelope-encrypted dispute mediation transcripts");
      expect(comment).toContain("7yr default retention");
      expect(comment).toContain("Issue #450");
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
      const failure = new Error('relation "dispute_mediation_transcripts" already exists');
      const query = jest.fn(async () => {
        throw failure;
      });
      const client = { query, release: jest.fn() } as unknown as PoolClient;

      await expect(migration.up(client)).rejects.toBe(failure);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("stops at the first failing index instead of continuing the run", async () => {
      const { client, queries } = makeClient({
        failOn: /idx_dispute_transcripts_kek_version/,
      });

      await expect(migration.up(client)).rejects.toThrow(
        "boom: statement rejected by the database",
      );

      // table + dispute index succeeded; the failing index is the last attempt.
      expect(queries).toHaveLength(3);
      expect(sqlList(queries)[2]).toContain("idx_dispute_transcripts_kek_version");
      expect(
        sqlList(queries).some((sql) =>
          sql.includes("idx_dispute_transcripts_retention_close"),
        ),
      ).toBe(false);
    });
  });

  describe("down()", () => {
    it("drops the table idempotently", async () => {
      const { client, queries } = makeClient();

      await migration.down(client);

      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toBe(
        "DROP TABLE IF EXISTS dispute_mediation_transcripts",
      );
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
