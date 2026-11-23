/**
 * Focused behaviour coverage for migration
 * `src/db/migrations/017_add_residency_waivers_table.ts`.
 *
 * The module creates the `residency_waivers` table used by the cross-region
 * egress guard, plus the two indexes that back its lookup paths:
 *
 *  - `idx_residency_waivers_lookup (scope, target_region) WHERE expires_at > NOW()`
 *    is the partial index that the guard middleware hits on every cross-region
 *    request. Keeping the predicate in the index (rather than only in the query)
 *    is what makes expired waivers cheap to skip.
 *  - `idx_residency_waivers_region (target_region, expires_at)` backs the
 *    administrative listing that must include expired rows.
 *
 * The tests pin the emitted SQL, the ordering (table before its indexes), the
 * temporal-validity predicate, and the failure contract: a rejected statement
 * surfaces to `MigrationRunner` and no further DDL is issued.
 *
 * Note: the module's `id` field is `"018"` even though the file is named
 * `017_...`; this suite pins the value that currently ships so that changing it
 * becomes an explicit, reviewable decision rather than an accident.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

import type { PoolClient } from "pg";
import { migration } from "../../db/migrations/017_add_residency_waivers_table.js";

interface QueryCall {
  text: string;
  values?: unknown[];
}

/** Build a mock `PoolClient` that records every statement. */
function createHarness() {
  const calls: QueryCall[] = [];
  const query = jest.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    return { rows: [] as unknown[] };
  });

  return { client: { query } as unknown as PoolClient, query, calls };
}

/** Collapse whitespace so assertions are insensitive to template indentation. */
function sql(call: QueryCall): string {
  return call.text.replace(/\s+/g, " ").trim();
}

describe("migration 017 — add_residency_waivers_table", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  describe("migration metadata", () => {
    it("keeps the currently registered id and name stable", () => {
      expect(migration.id).toBe("018");
      expect(migration.name).toBe("add_residency_waivers_table");
    });

    it("exposes up() and down() as callable migration hooks", () => {
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });
  });

  describe("up()", () => {
    it("creates the table before either supporting index", async () => {
      await migration.up(harness.client);

      expect(harness.calls).toHaveLength(3);
      expect(sql(harness.calls[0])).toContain("CREATE TABLE residency_waivers");
      // An index on a table that does not exist yet would abort the migration.
      expect(sql(harness.calls[1])).toContain("CREATE INDEX idx_residency_waivers_lookup");
      expect(sql(harness.calls[2])).toContain("CREATE INDEX idx_residency_waivers_region");
    });

    it("declares the columns and NOT NULL constraints the guard depends on", async () => {
      await migration.up(harness.client);

      const table = sql(harness.calls[0]);
      expect(table).toContain("id UUID PRIMARY KEY DEFAULT gen_random_uuid()");
      expect(table).toContain("target_region TEXT NOT NULL");
      expect(table).toContain("scope TEXT NOT NULL");
      expect(table).toContain("expires_at TIMESTAMPTZ NOT NULL");
      expect(table).toContain("created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      expect(table).toContain("created_by TEXT NOT NULL DEFAULT 'system'");
    });

    it("makes the primary lookup index partial on temporal validity", async () => {
      await migration.up(harness.client);

      const lookup = sql(harness.calls[1]);
      expect(lookup).toContain("ON residency_waivers (scope, target_region)");
      // Expired waivers must be excluded by the index itself.
      expect(lookup).toContain("WHERE expires_at > NOW()");
    });

    it("keeps the administrative index non-partial so expired rows remain listable", async () => {
      await migration.up(harness.client);

      const region = sql(harness.calls[2]);
      expect(region).toContain("ON residency_waivers (target_region, expires_at)");
      expect(region).not.toContain("WHERE");
    });

    it("is schema-only: no row reads/writes and no bound parameters", async () => {
      await migration.up(harness.client);

      for (const call of harness.calls) {
        expect(call.values).toBeUndefined();
        expect(sql(call)).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\b/);
      }
    });

    it("stops when the CREATE TABLE is rejected — no orphan indexes are attempted", async () => {
      harness.query.mockRejectedValueOnce(
        new Error('relation "residency_waivers" already exists') as never,
      );

      await expect(migration.up(harness.client)).rejects.toThrow("already exists");

      expect(harness.calls).toHaveLength(1);
      expect(sql(harness.calls[0])).toContain("CREATE TABLE residency_waivers");
    });

    it("stops after a failed lookup-index build so the second index is not attempted", async () => {
      harness.query
        .mockResolvedValueOnce({ rows: [] } as never) // CREATE TABLE
        .mockRejectedValueOnce(new Error("invalid index predicate") as never);

      await expect(migration.up(harness.client)).rejects.toThrow("invalid index predicate");

      expect(harness.calls).toHaveLength(2);
      expect(sql(harness.calls[1])).toContain("idx_residency_waivers_lookup");
    });

    it("propagates the original driver error object unchanged", async () => {
      const denied = Object.assign(new Error("permission denied for schema public"), {
        code: "42501",
      });
      harness.query.mockRejectedValueOnce(denied as never);

      await expect(migration.up(harness.client)).rejects.toBe(denied);
    });
  });

  describe("down()", () => {
    it("drops the table with IF EXISTS so a partial up() can still roll back", async () => {
      await migration.down(harness.client);

      expect(harness.calls).toHaveLength(1);
      expect(sql(harness.calls[0])).toMatch(/DROP TABLE IF EXISTS residency_waivers/);
    });

    it("propagates a rejected DROP TABLE", async () => {
      harness.query.mockRejectedValueOnce(new Error("cannot drop table: dependent objects") as never);

      await expect(migration.down(harness.client)).rejects.toThrow("dependent objects");
      expect(harness.calls).toHaveLength(1);
    });
  });

  describe("up()/down() round trip", () => {
    it("creates the table on the way up and removes it on the way down", async () => {
      await migration.up(harness.client);
      expect(harness.calls).toHaveLength(3);
      expect(harness.calls.map(sql).every((s) => !s.startsWith("DROP TABLE"))).toBe(true);

      harness.calls.length = 0;
      await migration.down(harness.client);

      expect(harness.calls).toHaveLength(1);
      expect(sql(harness.calls[0])).toMatch(/DROP TABLE IF EXISTS residency_waivers/);
    });
  });
});
