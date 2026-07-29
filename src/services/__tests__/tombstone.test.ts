/**
 * tombstone.test.ts
 *
 * Unit tests for the null-with-hash tombstone engine.
 *
 * The DB client is a hand-crafted fake: it tracks which SELECT and UPDATE
 * statements were executed, and returns configurable row fixtures.
 */

import { jest } from "@jest/globals";
import {
  tombstoneTable,
  sha256Hex,
  type TombstoneOptions,
} from "../../services/gdprErasure/tombstone.js";
import type { PiiColumn } from "../../services/gdprErasure/dependencyGraph.js";
import type { PoolClient } from "pg";

// ─── Fake DB client ───────────────────────────────────────────────────────────

interface FakeQueryCall {
  sql: string;
  params: unknown[];
}

function makeFakeClient(rowFixtures: Record<string, unknown[]> = {}): {
  client: PoolClient;
  calls: FakeQueryCall[];
} {
  const calls: FakeQueryCall[] = [];

  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.trim(), params });
      // Return rows if the fixture matches the table name in a SELECT.
      for (const [key, rows] of Object.entries(rowFixtures)) {
        if (sql.includes(key) && sql.trimStart().toUpperCase().startsWith("SELECT")) {
          return { rows };
        }
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  } as unknown as PoolClient;

  return { client, calls };
}

// ─── sha256Hex ────────────────────────────────────────────────────────────────

describe("sha256Hex", () => {
  it("returns a 64-char hex string", () => {
    const h = sha256Hex("hello");
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  it("returns the same hash for the same input", () => {
    expect(sha256Hex("alice@example.com")).toBe(sha256Hex("alice@example.com"));
  });

  it("treats null and undefined as empty string", () => {
    const h = sha256Hex(null);
    expect(h).toBe(sha256Hex(undefined));
    expect(h).toBe(sha256Hex(""));
  });

  it("produces different hashes for different inputs", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

// ─── tombstoneTable ───────────────────────────────────────────────────────────

const EMAIL_COL: PiiColumn = { name: "email", storeHash: true };
const NAME_COL: PiiColumn = { name: "name", storeHash: true };
const ADDRESS_COL: PiiColumn = { name: "billing_address", storeHash: false };
const NOTE_COL: PiiColumn = { name: "note", storeHash: true };

describe("tombstoneTable", () => {
  const SUBJECT_ID = "user-abc-123";
  const LIVE: TombstoneOptions = { dryRun: false };
  const DRY: TombstoneOptions = { dryRun: true };

  // ── No rows ─────────────────────────────────────────────────────────────────

  it("returns zero rowsAffected and empty actions when no rows found", async () => {
    const { client } = makeFakeClient({ users: [] });
    const result = await tombstoneTable(client, "users", "id", "id", [EMAIL_COL], SUBJECT_ID, LIVE);
    expect(result.rowsAffected).toBe(0);
    expect(result.actions).toHaveLength(0);
  });

  it("still selects rows in dry-run even when no rows exist", async () => {
    const { client, calls } = makeFakeClient({ booking_intents: [] });
    await tombstoneTable(client, "booking_intents", "id", "customer_id", [NOTE_COL], SUBJECT_ID, DRY);
    const selectCalls = calls.filter((c) => c.sql.toUpperCase().startsWith("SELECT"));
    expect(selectCalls.length).toBeGreaterThan(0);
  });

  // ── Live mode ────────────────────────────────────────────────────────────────

  it("issues an UPDATE for each matching row in live mode", async () => {
    const rows = [{ id: "row-1", email: "alice@example.com" }];
    const { client, calls } = makeFakeClient({ users: rows });

    const result = await tombstoneTable(client, "users", "id", "id", [EMAIL_COL], SUBJECT_ID, LIVE);

    expect(result.rowsAffected).toBe(1);
    const updates = calls.filter((c) => c.sql.toUpperCase().startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    // Verify the UPDATE targets the right table and nulls the column.
    expect(updates[0].sql).toContain("users");
    expect(updates[0].sql).toContain("email = NULL");
    expect(updates[0].sql).toContain("hash_email");
  });

  it("sets hash_<col> to SHA-256 of the original value when storeHash=true", async () => {
    const originalEmail = "alice@example.com";
    const expectedHash = sha256Hex(originalEmail);
    const rows = [{ id: "row-1", email: originalEmail }];
    const { client, calls } = makeFakeClient({ users: rows });

    await tombstoneTable(client, "users", "id", "id", [EMAIL_COL], SUBJECT_ID, LIVE);

    const update = calls.find((c) => c.sql.toUpperCase().startsWith("UPDATE"));
    expect(update?.params).toContain(expectedHash);
  });

  it("does NOT store hash when storeHash=false", async () => {
    const rows = [{ id: "row-1", billing_address: "123 Main St" }];
    const { client, calls } = makeFakeClient({ checkout_sessions: rows });

    await tombstoneTable(
      client,
      "checkout_sessions",
      "id",
      "customer_id",
      [ADDRESS_COL],
      SUBJECT_ID,
      LIVE,
    );

    const update = calls.find((c) => c.sql.toUpperCase().startsWith("UPDATE"));
    expect(update?.sql).not.toContain("hash_billing_address");
  });

  it("tombstones multiple PII columns in a single UPDATE", async () => {
    const rows = [{ id: "row-1", email: "a@b.com", name: "Alice" }];
    const { client, calls } = makeFakeClient({ users: rows });

    await tombstoneTable(
      client,
      "users",
      "id",
      "id",
      [EMAIL_COL, NAME_COL],
      SUBJECT_ID,
      LIVE,
    );

    const update = calls.find((c) => c.sql.toUpperCase().startsWith("UPDATE"));
    expect(update?.sql).toContain("email = NULL");
    expect(update?.sql).toContain("name = NULL");
    expect(update?.sql).toContain("hash_email");
    expect(update?.sql).toContain("hash_name");
  });

  it("processes multiple rows with a separate UPDATE per row", async () => {
    const rows = [
      { id: "row-1", email: "a@b.com" },
      { id: "row-2", email: "c@d.com" },
    ];
    const { client, calls } = makeFakeClient({ users: rows });

    const result = await tombstoneTable(
      client,
      "users",
      "id",
      "id",
      [EMAIL_COL],
      SUBJECT_ID,
      LIVE,
    );

    expect(result.rowsAffected).toBe(2);
    const updates = calls.filter((c) => c.sql.toUpperCase().startsWith("UPDATE"));
    expect(updates).toHaveLength(2);
  });

  it("includes action details for each row", async () => {
    const rows = [{ id: "row-1", email: "a@b.com", name: "Alice" }];
    const { client } = makeFakeClient({ users: rows });

    const result = await tombstoneTable(
      client,
      "users",
      "id",
      "id",
      [EMAIL_COL, NAME_COL],
      SUBJECT_ID,
      LIVE,
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].table).toBe("users");
    expect(result.actions[0].rowId).toBe("row-1");
    expect(result.actions[0].nulledColumns).toContain("email");
    expect(result.actions[0].nulledColumns).toContain("name");
    expect(result.actions[0].hashedColumns).toContain("hash_email");
  });

  // ── Dry-run mode ─────────────────────────────────────────────────────────────

  it("does NOT issue an UPDATE in dry-run mode", async () => {
    const rows = [{ id: "row-1", email: "a@b.com" }];
    const { client, calls } = makeFakeClient({ users: rows });

    await tombstoneTable(client, "users", "id", "id", [EMAIL_COL], SUBJECT_ID, DRY);

    const updates = calls.filter((c) => c.sql.toUpperCase().startsWith("UPDATE"));
    expect(updates).toHaveLength(0);
  });

  it("still returns actions in dry-run (for audit preview)", async () => {
    const rows = [{ id: "row-1", email: "a@b.com" }];
    const { client } = makeFakeClient({ users: rows });

    const result = await tombstoneTable(client, "users", "id", "id", [EMAIL_COL], SUBJECT_ID, DRY);

    expect(result.actions).toHaveLength(1);
    // rowsAffected is 0 in dry-run (no actual SQL changes)
    expect(result.rowsAffected).toBe(0);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────────

  it("skips columns that equal the pkCol or fkCol", async () => {
    // "id" column is pkCol — should not be nulled.
    const rows = [{ id: "row-1", email: "a@b.com" }];
    const { client, calls } = makeFakeClient({ users: rows });

    const idCol: PiiColumn = { name: "id", storeHash: false };
    await tombstoneTable(
      client,
      "users",
      "id",
      "id",
      [idCol, EMAIL_COL],
      SUBJECT_ID,
      LIVE,
    );

    const update = calls.find((c) => c.sql.toUpperCase().startsWith("UPDATE"));
    // id should not appear in SET clause as a target
    expect(update?.sql).not.toContain("id = NULL");
    expect(update?.sql).toContain("email = NULL");
  });

  it("handles NULL original value gracefully (no hash stored)", async () => {
    const rows = [{ id: "row-1", email: null }];
    const { client, calls } = makeFakeClient({ users: rows });

    await tombstoneTable(client, "users", "id", "id", [EMAIL_COL], SUBJECT_ID, LIVE);

    const update = calls.find((c) => c.sql.toUpperCase().startsWith("UPDATE"));
    // When original is null, storeHash still inserts hash_email? Per spec: skip hash if null.
    // Our implementation skips storeHash when value is null/undefined.
    expect(update?.sql).not.toContain("hash_email");
  });

  it("returns the correct table name in the result", async () => {
    const { client } = makeFakeClient({ booking_intents: [] });
    const result = await tombstoneTable(
      client,
      "booking_intents",
      "id",
      "customer_id",
      [NOTE_COL],
      SUBJECT_ID,
      LIVE,
    );
    expect(result.table).toBe("booking_intents");
  });
});
