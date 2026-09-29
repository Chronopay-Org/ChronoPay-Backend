/**
 * Focused behavior coverage for `migrationRepository.ts`.
 *
 * The module is the single place that talks to the `schema_migrations` table.
 * It deliberately depends on the structural `QueryClient` contract (satisfied by
 * both `Pool` and `PoolClient`), so these tests drive it with an in-memory fake
 * that records every emitted (text, values) pair. That makes the SQL text, the
 * parameterization, the row mapping and the failure propagation all observable
 * and deterministic without a database.
 *
 * Covered surface: `QueryClient`, `AppliedMigration`, `ensureMigrationsTable`,
 * plus the read/write helpers that share the same contract.
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  ensureMigrationsTable,
  getAppliedMigrations,
  recordMigration,
  removeMigration,
  type QueryClient,
} from "../migrationRepository.js";

// ─── Fake QueryClient ────────────────────────────────────────────────────────

interface Call {
  text: string;
  values?: unknown[];
}

function makeClient(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const client: QueryClient = {
    query: jest.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rows };
    }),
  };
  return { client, calls };
}

function makeFailingClient(error: Error) {
  const client: QueryClient = {
    query: jest.fn(async () => {
      throw error;
    }),
  };
  return client;
}

// ─── ensureMigrationsTable ───────────────────────────────────────────────────

describe("ensureMigrationsTable", () => {
  it("creates the tracking table with the documented columns", async () => {
    const { client, calls } = makeClient();

    await ensureMigrationsTable(client);

    expect(calls).toHaveLength(1);
    const sql = calls[0].text;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
    expect(sql).toContain("id         VARCHAR(255) PRIMARY KEY");
    expect(sql).toContain("name       VARCHAR(255) NOT NULL");
    expect(sql).toContain("applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()");
    // DDL is not parameterized.
    expect(calls[0].values).toBeUndefined();
  });

  it("is idempotent — issuing the guarded statement on every call", async () => {
    const { client, calls } = makeClient();

    await ensureMigrationsTable(client);
    await ensureMigrationsTable(client);

    expect(calls).toHaveLength(2);
    expect(calls[0].text).toBe(calls[1].text);
    expect(calls[1].text).toContain("IF NOT EXISTS");
  });

  it("propagates a client failure instead of swallowing it", async () => {
    const client = makeFailingClient(new Error("connection terminated"));

    await expect(ensureMigrationsTable(client)).rejects.toThrow("connection terminated");
  });
});

// ─── getAppliedMigrations ────────────────────────────────────────────────────

describe("getAppliedMigrations", () => {
  it("selects the documented columns ordered by id ascending", async () => {
    const { client, calls } = makeClient([]);

    await getAppliedMigrations(client);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("SELECT id, name, applied_at FROM schema_migrations");
    expect(calls[0].text).toContain("ORDER BY id ASC");
    expect(calls[0].values).toBeUndefined();
  });

  it("maps rows to AppliedMigration while preserving the returned order", async () => {
    const appliedAtA = new Date("2026-01-01T00:00:00Z");
    const appliedAtB = new Date("2026-02-01T00:00:00Z");
    const { client } = makeClient([
      { id: "001_init", name: "init", applied_at: appliedAtA },
      { id: "002_extend", name: "extend", applied_at: appliedAtB },
    ]);

    const result = await getAppliedMigrations(client);

    expect(result).toEqual([
      { id: "001_init", name: "init", applied_at: appliedAtA },
      { id: "002_extend", name: "extend", applied_at: appliedAtB },
    ]);
    expect(result[0].applied_at).toBeInstanceOf(Date);
  });

  it("drops unrelated columns from the returned shape", async () => {
    const { client } = makeClient([
      {
        id: "001_init",
        name: "init",
        applied_at: new Date("2026-01-01T00:00:00Z"),
        internal_seq: 42,
        checksum: "deadbeef",
      },
    ]);

    const [row] = await getAppliedMigrations(client);

    expect(Object.keys(row).sort()).toEqual(["applied_at", "id", "name"]);
  });

  it("returns an empty array when nothing has been applied", async () => {
    const { client } = makeClient([]);

    await expect(getAppliedMigrations(client)).resolves.toEqual([]);
  });

  it("propagates a client failure", async () => {
    const client = makeFailingClient(new Error("read failed"));

    await expect(getAppliedMigrations(client)).rejects.toThrow("read failed");
  });
});

// ─── recordMigration ─────────────────────────────────────────────────────────

describe("recordMigration", () => {
  it("inserts the id and name through bound parameters", async () => {
    const { client, calls } = makeClient();

    await recordMigration(client, "003_add_indexes", "add_indexes");

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)");
    expect(calls[0].values).toEqual(["003_add_indexes", "add_indexes"]);
  });

  it("never interpolates the caller-controlled id into the SQL text", async () => {
    const { client, calls } = makeClient();
    const hostileId = "001'); DROP TABLE schema_migrations; --";

    await recordMigration(client, hostileId, "hostile");

    expect(calls[0].text).not.toContain("DROP TABLE");
    expect(calls[0].values).toEqual([hostileId, "hostile"]);
  });

  it("propagates a unique-violation failure", async () => {
    const client = makeFailingClient(new Error("duplicate key value violates unique constraint"));

    await expect(recordMigration(client, "001_init", "init")).rejects.toThrow(
      "duplicate key value violates unique constraint",
    );
  });
});

// ─── removeMigration ─────────────────────────────────────────────────────────

describe("removeMigration", () => {
  it("deletes by bound id parameter", async () => {
    const { client, calls } = makeClient();

    await removeMigration(client, "003_add_indexes");

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("DELETE FROM schema_migrations WHERE id = $1");
    expect(calls[0].values).toEqual(["003_add_indexes"]);
  });

  it("resolves even when the row was already gone (no row-count coupling)", async () => {
    const { client } = makeClient([]);

    await expect(removeMigration(client, "missing")).resolves.toBeUndefined();
  });

  it("propagates a client failure", async () => {
    const client = makeFailingClient(new Error("delete failed"));

    await expect(removeMigration(client, "001_init")).rejects.toThrow("delete failed");
  });
});

// ─── QueryClient structural contract ─────────────────────────────────────────

describe("QueryClient structural contract", () => {
  it("accepts any client whose query returns a rows array (Pool-like shape)", async () => {
    const poolLike: QueryClient = {
      async query() {
        return { rows: [{ id: "001_init", name: "init", applied_at: 1 }] };
      },
    };

    const rows = await getAppliedMigrations(poolLike);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("001_init");
  });

  it("accepts a transaction client whose query takes optional values", async () => {
    const txClient: QueryClient = {
      query: async (_text: string, _values?: unknown[]) => ({ rows: [] }),
    };

    await expect(ensureMigrationsTable(txClient)).resolves.toBeUndefined();
    await expect(recordMigration(txClient, "001_init", "init")).resolves.toBeUndefined();
  });
});
