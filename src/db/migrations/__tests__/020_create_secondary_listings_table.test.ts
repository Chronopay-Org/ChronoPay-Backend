/**
 * Focused behaviour suite for `migration` in
 * `src/db/migrations/020_create_secondary_listings_table.ts` (issue #1062).
 *
 * The module had no associated fixture, so nothing pinned what it actually executes.
 * That matters more than usual here, because the migration's contract is *entirely*
 * about the SQL it issues and the ordering of that SQL:
 *
 *  - `up()` must create the enum before the table that uses it, and the index last.
 *  - `down()` must drop in the exact reverse order — the enum cannot be dropped while
 *    a column still depends on it.
 *  - The module must stay a pure, dependency-injected unit: it receives a client, issues
 *    statements on it, and never opens a connection, controls transactions, or releases
 *    the client it does not own (that is `withTransaction`/the runner's job).
 *
 * This suite drives the migration with an injected recording client, so the assertions
 * are on observed calls rather than on a live database. That keeps the failure and
 * boundary behaviour deterministic and makes the fail-fast contract observable.
 *
 * No production code is changed. Two current behaviours that are questionable
 * (non-idempotent `up`, and the module's absence from the migration registry) are pinned
 * or reported rather than fixed, and are called out in the pull request.
 */

import { jest, describe, it, expect } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../020_create_secondary_listings_table.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type RecordedCall = { text: string; values: unknown[] | undefined };

/** Collapses the DDL's formatting so assertions read as SQL rather than as indentation. */
const sql = (text: string): string => text.replace(/\s+/g, " ").trim();

interface RecordingClient {
  client: PoolClient;
  calls: RecordedCall[];
  query: ReturnType<typeof jest.fn>;
  release: ReturnType<typeof jest.fn>;
}

function recordingClient(): RecordingClient {
  const calls: RecordedCall[] = [];
  const query = jest.fn<any>(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    return { rows: [] };
  });
  const release = jest.fn<any>();
  return { client: { query, release } as unknown as PoolClient, calls, query, release };
}

/** A client that rejects on the Nth statement, recording everything it was asked to run. */
function clientFailingOn(n: number, rejection: unknown): {
  client: PoolClient;
  attempted: string[];
} {
  const attempted: string[] = [];
  const query = jest.fn<any>(async (text: string) => {
    attempted.push(sql(text));
    if (attempted.length === n) throw rejection;
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, attempted };
}

const statementsFor = async (run: (client: PoolClient) => Promise<void>): Promise<string[]> => {
  const { client, calls } = recordingClient();
  await run(client);
  return calls.map((c) => sql(c.text));
};

// ─── Module contract ──────────────────────────────────────────────────────────

describe("migration 020 — module contract", () => {
  it("declares the id and name the registry and drift detector key on", () => {
    expect(migration.id).toBe("020");
    expect(migration.name).toBe("create_secondary_listings_table");
  });

  it("exposes single-argument async up() and down() functions", () => {
    expect(migration.up).toBeInstanceOf(Function);
    expect(migration.down).toBeInstanceOf(Function);
    expect(migration.up.length).toBe(1);
    expect(migration.down.length).toBe(1);
  });

  it("resolves to undefined rather than reporting its own success", async () => {
    const { client } = recordingClient();

    await expect(migration.up(client)).resolves.toBeUndefined();
    await expect(migration.down(client)).resolves.toBeUndefined();
  });
});

// ─── up() ─────────────────────────────────────────────────────────────────────

describe("migration 020 — up()", () => {
  it("issues exactly three statements in dependency order: enum, table, index", async () => {
    const statements = await statementsFor((client) => migration.up(client));

    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^CREATE TYPE secondary_listing_state/);
    expect(statements[1]).toMatch(/^CREATE TABLE secondary_listings/);
    expect(statements[2]).toMatch(/^CREATE INDEX idx_secondary_listings_active_expiry/);
  });

  it("creates the enum with the four states, in order", async () => {
    const statements = await statementsFor((client) => migration.up(client));

    expect(statements[0]).toBe(
      "CREATE TYPE secondary_listing_state AS ENUM ('active', 'expired', 'cancelled', 'sold')",
    );
  });

  it("creates the table with the id primary key and a unique slot_id", async () => {
    const [, table] = await statementsFor((client) => migration.up(client));

    expect(table).toMatch(/id TEXT PRIMARY KEY/);
    expect(table).toMatch(/slot_id TEXT NOT NULL UNIQUE/);
    expect(table).toMatch(/owner_id TEXT NOT NULL/);
  });

  it("enforces a positive price floor in the database, not only in the app", async () => {
    const [, table] = await statementsFor((client) => migration.up(client));

    expect(table).toMatch(/price_floor_cents BIGINT NOT NULL CHECK \(price_floor_cents > 0\)/);
  });

  it("enforces a non-zero expiry in the database", async () => {
    const [, table] = await statementsFor((client) => migration.up(client));

    expect(table).toMatch(/expires_at BIGINT NOT NULL CHECK \(expires_at > 0\)/);
  });

  it("defaults supplier_consent to false so consent must be granted explicitly", async () => {
    const [, table] = await statementsFor((client) => migration.up(client));

    expect(table).toMatch(/supplier_consent BOOLEAN NOT NULL DEFAULT false/);
  });

  it("defaults state to active and both timestamps to NOW()", async () => {
    const [, table] = await statementsFor((client) => migration.up(client));

    expect(table).toMatch(/state secondary_listing_state NOT NULL DEFAULT 'active'/);
    expect(table).toMatch(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
    expect(table).toMatch(/updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  });

  it("creates a partial index covering only active listings, ordered by expiry", async () => {
    const statements = await statementsFor((client) => migration.up(client));

    expect(statements[2]).toBe(
      "CREATE INDEX idx_secondary_listings_active_expiry ON secondary_listings (state, expires_at) WHERE state = 'active'",
    );
  });

  it("passes no bind parameters — the DDL is fully static", async () => {
    const { client, query } = recordingClient();
    await migration.up(client);

    expect(query).toHaveBeenCalledTimes(3);
    for (const call of query.mock.calls) {
      expect(call).toHaveLength(1);
      expect(typeof call[0]).toBe("string");
    }
  });

  it("is deterministic across invocations", async () => {
    const first = await statementsFor((client) => migration.up(client));
    const second = await statementsFor((client) => migration.up(client));

    expect(second).toEqual(first);
  });

  it("does not declare IF NOT EXISTS — up() is not re-runnable", async () => {
    // Characterisation: `CREATE TYPE` has no IF NOT EXISTS form in PostgreSQL, so a
    // re-run against a partially applied schema fails. The runner's applied-migration
    // bookkeeping is what prevents that, not the SQL itself.
    const statements = await statementsFor((client) => migration.up(client));

    expect(statements.join(" ")).not.toMatch(/IF NOT EXISTS/i);
  });

  it("leaves transaction control to the runner", async () => {
    const statements = await statementsFor((client) => migration.up(client));

    expect(statements.join(" ")).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i);
  });

  it("does not release the client it was handed", async () => {
    const { client, release } = recordingClient();

    await migration.up(client);

    expect(release).not.toHaveBeenCalled();
  });
});

// ─── down() ───────────────────────────────────────────────────────────────────

describe("migration 020 — down()", () => {
  it("issues exactly two statements", async () => {
    const statements = await statementsFor((client) => migration.down(client));

    expect(statements).toHaveLength(2);
  });

  it("drops the table before the enum so no dependent object is left behind", async () => {
    const statements = await statementsFor((client) => migration.down(client));

    expect(statements[0]).toBe("DROP TABLE IF EXISTS secondary_listings");
    expect(statements[1]).toBe("DROP TYPE IF EXISTS secondary_listing_state");
  });

  it("uses IF EXISTS so it survives a partially applied or already-rolled-back schema", async () => {
    const statements = await statementsFor((client) => migration.down(client));

    expect(statements).toEqual([
      "DROP TABLE IF EXISTS secondary_listings",
      "DROP TYPE IF EXISTS secondary_listing_state",
    ]);
  });

  it("reverses the creation order of up(), index first to go in real terms", async () => {
    const upStatements = await statementsFor((client) => migration.up(client));
    const downStatements = await statementsFor((client) => migration.down(client));

    const createdTable = upStatements.findIndex((s) => s.startsWith("CREATE TABLE"));
    const createdType = upStatements.findIndex((s) => s.startsWith("CREATE TYPE"));
    const droppedTable = downStatements.findIndex((s) => s.startsWith("DROP TABLE"));
    const droppedType = downStatements.findIndex((s) => s.startsWith("DROP TYPE"));

    expect(createdType).toBeLessThan(createdTable);
    expect(droppedTable).toBeLessThan(droppedType);
    expect(downStatements.join(" ")).not.toMatch(/idx_secondary_listings_active_expiry/);
  });

  it("leaves transaction control to the runner", async () => {
    const statements = await statementsFor((client) => migration.down(client));

    expect(statements.join(" ")).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i);
  });

  it("does not release the client it was handed", async () => {
    const { client, release } = recordingClient();

    await migration.down(client);

    expect(release).not.toHaveBeenCalled();
  });
});

// ─── Failure handling ─────────────────────────────────────────────────────────

describe("migration 020 — failure handling", () => {
  it.each([1, 2, 3])(
    "stops immediately and propagates when up()'s statement %i fails",
    async (failingStatement) => {
      const boom = new Error(`statement ${failingStatement} rejected`);
      const { client, attempted } = clientFailingOn(failingStatement, boom);

      await expect(migration.up(client)).rejects.toBe(boom);
      // No further statements were issued after the failure.
      expect(attempted).toHaveLength(failingStatement);
    },
  );

  it.each([1, 2])(
    "stops immediately and propagates when down()'s statement %i fails",
    async (failingStatement) => {
      const boom = new Error(`drop ${failingStatement} rejected`);
      const { client, attempted } = clientFailingOn(failingStatement, boom);

      await expect(migration.down(client)).rejects.toBe(boom);
      expect(attempted).toHaveLength(failingStatement);
    },
  );

  it("propagates non-Error rejections without wrapping them", async () => {
    const { client } = clientFailingOn(1, "connection reset");

    await expect(migration.up(client)).rejects.toBe("connection reset");
  });

  it("reports failure for up() when the enum cannot be created", async () => {
    const collision = new Error('type "secondary_listing_state" already exists');
    const { client, attempted } = clientFailingOn(1, collision);

    await expect(migration.up(client)).rejects.toThrow(/already exists/);
    // The table is never attempted, so the schema is left consistently at "no table".
    expect(attempted).toEqual([
      "CREATE TYPE secondary_listing_state AS ENUM ('active', 'expired', 'cancelled', 'sold')",
    ]);
  });

  it("reports failure for down() when the table cannot be dropped", async () => {
    const inUse = new Error("cannot drop table secondary_listings because other objects depend on it");
    const { client, attempted } = clientFailingOn(1, inUse);

    await expect(migration.down(client)).rejects.toThrow(/depend on it/);
    // The enum drop is not attempted, so the type is never orphaned by a half-rollback.
    expect(attempted).toEqual(["DROP TABLE IF EXISTS secondary_listings"]);
  });

  it("surfaces a rejection from the very first call as the original error instance", async () => {
    const original = new Error("driver exploded");
    const { client } = clientFailingOn(1, original);

    let caught: unknown;
    try {
      await migration.up(client);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(original);
  });
});
