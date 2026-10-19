/**
 * Tests for src/db/migrations/002_create_slots_table.ts
 *
 * Migration 002 is pure DDL: its public contract is the *set and order of
 * statements* it issues against a PoolClient, plus the shape of the
 * `Migration` record (id/name/up/down). There is no branching logic, so the
 * tests assert on the recorded SQL rather than on a live database.
 *
 * Style follows src/__tests__/db/connection.test.ts: `pg` is aliased to a
 * stub by jest.config.cjs, so a hand-rolled fake PoolClient is injected as a
 * plain object cast — no jest.mock() required.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../002_create_slots_table.js";
import { MigrationRunner } from "../../migrationRunner.js";

// ─── Fake PoolClient ─────────────────────────────────────────────────────────

type QueryError = Error & { code?: string };

const query = jest.fn<(text: string) => Promise<{ rows: unknown[] }>>();
const client = { query } as unknown as PoolClient;

/** Every SQL string handed to the client, in execution order. */
const issuedSql = (): string[] => query.mock.calls.map((c) => c[0]);

/** Normalised (whitespace-collapsed) SQL for robust substring assertions. */
const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** True when any issued statement contains `fragment` (whitespace-insensitive). */
const issuedSqlContaining = (fragment: string): boolean =>
  issuedSql().some((sql) => normalize(sql).includes(fragment));

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

// ─── Migration contract ──────────────────────────────────────────────────────

describe("migration 002 — create_slots_table contract", () => {
  it("declares the identity the migration runner and drift detector key off", () => {
    expect(migration.id).toBe("002");
    expect(migration.name).toBe("create_slots_table");
  });

  it("exposes both up() and down() as functions", () => {
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("declares a sortable, zero-padded id so registry ordering stays lexical", () => {
    expect(migration.id).toMatch(/^\d{3}$/);
  });

  it("declares a snake_case name, as the drift detector's naming convention requires", () => {
    expect(migration.name).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
  });

  it("passes MigrationRunner.validate()", async () => {
    const runner = new MigrationRunner({} as never, {} as never, [migration]);

    await expect(runner.validate()).resolves.toEqual({ valid: true, errors: [] });
  });
});

// ─── up() — statement order ──────────────────────────────────────────────────

describe("migration 002 up()", () => {
  it("issues four statements in dependency order: type, table, indexes", async () => {
    await migration.up(client);

    const statements = issuedSql().map(normalize);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toBe(
      "CREATE TYPE slot_status AS ENUM ('available', 'booked', 'cancelled')",
    );
    expect(statements[1]).toMatch(/^CREATE TABLE slots \(/);
    expect(statements[2]).toMatch(/^CREATE INDEX idx_slots_professional_id/);
    expect(statements[3]).toMatch(/^CREATE INDEX idx_slots_start_time/);
  });

  it("creates the enum before the table that consumes it", async () => {
    await migration.up(client);

    const statements = issuedSql().map(normalize);
    const typeIndex = statements.findIndex((s) => s.includes("CREATE TYPE slot_status"));
    const tableIndex = statements.findIndex((s) => s.includes("CREATE TABLE slots"));
    expect(typeIndex).toBeGreaterThanOrEqual(0);
    expect(tableIndex).toBeGreaterThan(typeIndex);
  });

  it("creates the table before the indexes that target it", async () => {
    await migration.up(client);

    const statements = issuedSql().map(normalize);
    const tableIndex = statements.findIndex((s) => s.includes("CREATE TABLE slots"));
    const firstIndex = statements.findIndex((s) => s.includes("CREATE INDEX idx_slots_"));
    expect(firstIndex).toBeGreaterThan(tableIndex);
  });

  it("returns no value and issues no parameterised queries", async () => {
    await expect(migration.up(client)).resolves.toBeUndefined();

    for (const call of query.mock.calls) {
      expect(call).toHaveLength(1);
    }
  });
});

// ─── up() — schema shape ─────────────────────────────────────────────────────

describe("migration 002 up() — slots table definition", () => {
  let rawTableSql: string;
  let tableSql: string;

  beforeEach(async () => {
    await migration.up(client);
    rawTableSql = issuedSql().find((s) => normalize(s).includes("CREATE TABLE slots")) ?? "";
    tableSql = normalize(rawTableSql);
  });

  it("declares slot_status as an enum with exactly the three expected statuses", () => {
    expect(normalize(issuedSql()[0])).toBe(
      "CREATE TYPE slot_status AS ENUM ('available', 'booked', 'cancelled')",
    );
  });

  it("uses a UUID primary key defaulted with gen_random_uuid()", () => {
    expect(tableSql).toContain("id UUID PRIMARY KEY DEFAULT gen_random_uuid()");
  });

  it("requires professional_id as a non-null FK to users with ON DELETE CASCADE", () => {
    expect(tableSql).toContain(
      "professional_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE",
    );
  });

  it("requires both start_time and end_time as timezone-aware timestamps", () => {
    expect(tableSql).toContain("start_time TIMESTAMPTZ NOT NULL");
    expect(tableSql).toContain("end_time TIMESTAMPTZ NOT NULL");
  });

  it("defaults status to 'available' and is backed by the slot_status enum", () => {
    expect(tableSql).toContain("status slot_status NOT NULL DEFAULT 'available'");
  });

  it("stamps created_at with NOW() as a non-null default", () => {
    expect(tableSql).toContain("created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  });

  it("guards the time window with the chk_slots_time_order CHECK constraint", () => {
    expect(tableSql).toContain("CONSTRAINT chk_slots_time_order CHECK (end_time > start_time)");
  });

  it("adds no columns beyond the agreed set", () => {
    // Parsed line-by-line from the raw statement so a new column is caught
    // by the exact-equality assertion below rather than by a substring check.
    const columns = [...rawTableSql.matchAll(/^\s{8}([a-z_]+)\s+(UUID|TIMESTAMPTZ|slot_status)/gm)]
      .map((m) => m[1])
      .filter((c) => c !== "constraint");

    expect(columns).toEqual([
      "id",
      "professional_id",
      "start_time",
      "end_time",
      "status",
      "created_at",
    ]);
  });
});

// ─── up() — indexes ──────────────────────────────────────────────────────────

describe("migration 002 up() — indexes", () => {
  it("indexes professional_id for per-professional slot lookups", async () => {
    await migration.up(client);

    expect(
      issuedSqlContaining("CREATE INDEX idx_slots_professional_id ON slots (professional_id)"),
    ).toBe(true);
  });

  it("indexes start_time for chronological availability queries", async () => {
    await migration.up(client);

    expect(issuedSqlContaining("CREATE INDEX idx_slots_start_time ON slots (start_time)")).toBe(
      true,
    );
  });

  it("does not add a UNIQUE or EXCLUDE index in this migration", async () => {
    await migration.up(client);

    // Overlap exclusion is added later by 003; 002 must not preempt it.
    expect(issuedSqlContaining("UNIQUE")).toBe(false);
    expect(issuedSqlContaining("EXCLUDE")).toBe(false);
  });
});

// ─── up() — failure paths ────────────────────────────────────────────────────

describe("migration 002 up() — failure handling", () => {
  /** Builds a pg-shaped error with an optional SQLSTATE code. */
  const pgError = (message: string, code?: string): QueryError =>
    Object.assign(new Error(message), code ? { code } : {});

  it("propagates the original error when the enum already exists", async () => {
    const alreadyExists = pgError('type "slot_status" already exists', "42710");
    query.mockRejectedValueOnce(alreadyExists);

    await expect(migration.up(client)).rejects.toBe(alreadyExists);
  });

  it("stops on the first failing statement and issues nothing after it", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    query.mockRejectedValueOnce(pgError('relation "slots" does not exist', "42P01"));

    await expect(migration.up(client)).rejects.toThrow('relation "slots" does not exist');

    // The two index statements must not run after the table creation failed.
    expect(query).toHaveBeenCalledTimes(2);
    expect(issuedSqlContaining("CREATE INDEX")).toBe(false);
  });

  it("surfaces the SQLSTATE code from an index build failure", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(pgError('relation "slots" does not exist', "42P01"));

    const error = await migration.up(client).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as QueryError).code).toBe("42P01");
    expect(issuedSqlContaining("idx_slots_start_time")).toBe(false);
  });

  it("propagates a missing-client rejection without swallowing it", async () => {
    const missingTable = pgError('relation "users" does not exist', "42P01");
    query.mockRejectedValueOnce(missingTable);

    await expect(migration.up(client)).rejects.toThrow(missingTable);
  });

  it("does not attempt cleanup or compensating statements after a failure", async () => {
    query.mockRejectedValueOnce(pgError("boom", "XX000"));

    await expect(migration.up(client)).rejects.toThrow("boom");

    expect(issuedSqlContaining("DROP")).toBe(false);
    expect(issuedSqlContaining("ROLLBACK")).toBe(false);
  });
});

// ─── down() ──────────────────────────────────────────────────────────────────

describe("migration 002 down()", () => {
  it("drops the table and the type in that order", async () => {
    await migration.down(client);

    expect(issuedSql().map(normalize)).toEqual([
      "DROP TABLE IF EXISTS slots",
      "DROP TYPE IF EXISTS slot_status",
    ]);
  });

  it("drops the table before the type it depends on", async () => {
    await migration.down(client);

    const statements = issuedSql().map(normalize);
    expect(statements[0]).toContain("DROP TABLE");
    expect(statements[1]).toContain("DROP TYPE");
  });

  it("uses IF EXISTS on both drops so a partial rollback is safe", async () => {
    await migration.down(client);

    expect(issuedSql().every((s) => normalize(s).includes("IF EXISTS"))).toBe(true);
  });

  it("returns no value", async () => {
    await expect(migration.down(client)).resolves.toBeUndefined();
  });

  it("leaves the enum drop unexecuted when the table drop fails", async () => {
    const stillReferenced = new Error(
      "cannot drop type slot_status because other objects depend on it",
    );
    query.mockRejectedValueOnce(stillReferenced);

    await expect(migration.down(client)).rejects.toBe(stillReferenced);

    expect(query).toHaveBeenCalledTimes(1);
    expect(issuedSqlContaining("DROP TYPE")).toBe(false);
  });

  it("is idempotent against a client that ignores the drops", async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(migration.down(client)).resolves.toBeUndefined();
    await expect(migration.down(client)).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(4);
  });
});

// ─── Round trip ──────────────────────────────────────────────────────────────

describe("migration 002 up()/down() round trip", () => {
  it("down() undoes exactly the objects up() created", async () => {
    await migration.up(client);
    expect(issuedSql()).toHaveLength(4);

    query.mockClear();
    await migration.down(client);

    const downStatements = issuedSql().map(normalize);
    expect(downStatements).toHaveLength(2);
    expect(downStatements[0]).toBe("DROP TABLE IF EXISTS slots");
    expect(downStatements[1]).toBe("DROP TYPE IF EXISTS slot_status");
  });

  it("produces no CREATE statement on the way back down", async () => {
    await migration.up(client);
    query.mockClear();
    await migration.down(client);

    expect(issuedSqlContaining("CREATE")).toBe(false);
  });
});
