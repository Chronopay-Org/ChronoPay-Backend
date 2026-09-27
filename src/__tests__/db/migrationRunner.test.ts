/**
 * Tests for src/db/migrationRunner.ts
 *
 * The MigrationRunner takes every dependency via its constructor (pool, repo,
 * migrations, transaction helper), so these tests are pure dependency
 * injection — no jest.mock() needed, matching the approach used by
 * connection.test.ts in this project's ESM + experimental-vm-modules setup.
 *
 * Coverage map:
 *  - Migration contract: order-preserving up/down execution, id/name recorded.
 *  - MigrationStatus: applied vs pending projection with applied_at.
 *  - MigrationResult: success/applied/failed/error on both up() and down().
 *  - validate(): invalid inputs (duplicate IDs, empty id/name, missing up/down).
 *  - State transitions: pending → applied → rolled back; stop-on-first-failure.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { PoolClient } from "pg";
import {
  MigrationRunner,
  type Migration,
  type MigrationRepository,
  type MigrationResult,
} from "../../db/migrationRunner.js";
import type { AppliedMigration } from "../../db/migrationRepository.js";

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** Transaction helper that just invokes fn with a sentinel client (no SQL). */
const passthroughTransact = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
  fn(FAKE_CLIENT);

const FAKE_CLIENT = { query: jest.fn<() => Promise<{ rows: never[] }>>().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;

/** In-memory MigrationRepository fake with call recording. */
function makeRepo(initialApplied: AppliedMigration[] = []) {
  const applied = new Map<string, AppliedMigration>(
    initialApplied.map((a) => [a.id, { ...a }]),
  );
  const calls = {
    ensureMigrationsTable: jest.fn<MigrationRepository["ensureMigrationsTable"]>(),
    getAppliedMigrations: jest.fn<MigrationRepository["getAppliedMigrations"]>(),
    recordMigration: jest.fn<MigrationRepository["recordMigration"]>(),
    removeMigration: jest.fn<MigrationRepository["removeMigration"]>(),
  };

  const repo: MigrationRepository = {
    ensureMigrationsTable: async (client) => {
      calls.ensureMigrationsTable(client);
    },
    getAppliedMigrations: async (client) => {
      calls.getAppliedMigrations(client);
      return [...applied.values()];
    },
    recordMigration: async (client, id, name) => {
      calls.recordMigration(client, id, name);
      applied.set(id, { id, name, applied_at: new Date("2026-01-01T00:00:00Z") });
    },
    removeMigration: async (client, id) => {
      calls.removeMigration(client, id);
      applied.delete(id);
    },
  };

  return { repo, calls, applied };
}

/** Deterministic migration factory with call tracking. */
function makeMigration(id: string, name = `migration_${id}`): Migration & {
  upCalls: PoolClient[];
  downCalls: PoolClient[];
} {
  const upCalls: PoolClient[] = [];
  const downCalls: PoolClient[] = [];
  return {
    id,
    name,
    up: async (client: PoolClient) => {
      upCalls.push(client);
    },
    down: async (client: PoolClient) => {
      downCalls.push(client);
    },
    upCalls,
    downCalls,
  };
}

function makeRunner(
  migrations: Migration[],
  applied: AppliedMigration[] = [],
  // Typed as `unknown` because jest.fn() collapses the generic signature of
  // passthroughTransact to Promise<unknown>. The runner force-casts anyway.
  transact: unknown = passthroughTransact,
) {
  const { repo, calls, applied: appliedMap } = makeRepo(applied);
  const runner = new MigrationRunner({} as never, repo, migrations, transact as never);
  return { runner, calls, appliedMap };
}

const appliedAt = new Date("2026-01-01T00:00:00Z");
const appliedRecord = (id: string, name: string): AppliedMigration => ({
  id,
  name,
  applied_at: appliedAt,
});

// ─── Migration contract via up()/down() ─────────────────────────────────────

describe("MigrationRunner.up()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("applies pending migrations in registration order inside a transaction each", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const transact = jest.fn(passthroughTransact);
    const { runner } = makeRunner([m1, m2], [], transact);

    const result = await runner.up();

    expect(result).toEqual({
      success: true,
      applied: ["001", "002"],
    } as MigrationResult);
    // Order preserved and each migration got the transaction client
    expect(m1.upCalls).toEqual([FAKE_CLIENT]);
    expect(m2.upCalls).toEqual([FAKE_CLIENT]);
    // One transaction per migration
    expect(transact).toHaveBeenCalledTimes(2);
    // Tracking records written inside the same transaction
    expect(m1.upCalls.length).toBe(1);
    expect(m2.upCalls.length).toBe(1);
  });

  it("records id and name in the tracking table for each applied migration", async () => {
    const m1 = makeMigration("001", "create_users_table");
    const { runner, calls } = makeRunner([m1]);

    await runner.up();

    expect(calls.recordMigration).toHaveBeenCalledWith(FAKE_CLIENT, "001", "create_users_table");
  });

  it("skips migrations that are already applied", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const { runner } = makeRunner([m1, m2], [appliedRecord("001", "migration_001")]);

    const result = await runner.up();

    expect(result).toEqual({ success: true, applied: ["002"] });
    expect(m1.upCalls).toHaveLength(0);
    expect(m2.upCalls).toHaveLength(1);
  });

  it("honors the count limit and leaves remaining migrations pending", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const m3 = makeMigration("003");
    const { runner } = makeRunner([m1, m2, m3]);

    const result = await runner.up(2);

    expect(result).toEqual({ success: true, applied: ["001", "002"] });
    expect(m3.upCalls).toHaveLength(0);
  });

  it("returns success with no applied ids when all migrations are already applied", async () => {
    const m1 = makeMigration("001");
    const { runner } = makeRunner([m1], [appliedRecord("001", "migration_001")]);

    const result = await runner.up();

    expect(result).toEqual({ success: true, applied: [] });
    expect(m1.upCalls).toHaveLength(0);
  });

  it("returns success with empty applied list when no migrations are registered", async () => {
    const { runner } = makeRunner([]);

    await expect(runner.up()).resolves.toEqual({ success: true, applied: [] });
  });

  // ── Failure paths ────────────────────────────────────────────────────────

  it("reports the failed migration and stops before later pending ones", async () => {
    const m1 = makeMigration("001");
    const boom = new Error("duplicate table");
    const m2: Migration = {
      ...makeMigration("002"),
      up: async () => {
        throw boom;
      },
    };
    const m3 = makeMigration("003");
    const { runner, appliedMap } = makeRunner([m1, m2, m3]);

    const result = await runner.up();

    expect(result).toEqual({
      success: false,
      applied: ["001"],
      failed: "002",
      error: boom,
    } as MigrationResult);
    expect(m3.upCalls).toHaveLength(0); // stop-on-first-failure
    // Tracking record for the failed migration must not exist
    expect(appliedMap.has("002")).toBe(false);
  });

  it("keeps the tracking record of migrations applied before the failure", async () => {
    const m1 = makeMigration("001");
    const m2: Migration = {
      ...makeMigration("002"),
      up: async () => {
        throw new Error("boom");
      },
    };
    const { runner, appliedMap } = makeRunner([m1, m2]);

    await runner.up();

    expect(appliedMap.has("001")).toBe(true);
    expect(appliedMap.has("002")).toBe(false);
  });

  it("wraps non-Error thrown values into an Error for the result", async () => {
    const m1: Migration = {
      ...makeMigration("001"),
      up: async () => {
        throw "string failure";
      },
    };
    const { runner } = makeRunner([m1]);

    const result = await runner.up();

    expect(result.success).toBe(false);
    expect(result.failed).toBe("001");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("string failure");
  });

  it("fails when the repository record insert throws after a successful up()", async () => {
    const m1 = makeMigration("001");
    const { repo } = makeRepo();
    const recordBoom = new Error("insert failed");
    repo.recordMigration = async () => {
      throw recordBoom;
    };
    const runner = new MigrationRunner({} as never, repo, [m1], passthroughTransact as never);

    const result = await runner.up();

    expect(result).toEqual({
      success: false,
      applied: [],
      failed: "001",
      error: recordBoom,
    } as MigrationResult);
    expect(m1.upCalls).toHaveLength(1); // up ran, but record failed
  });

  it("propagates errors thrown before any migration runs (e.g. ensureMigrationsTable)", async () => {
    const { repo } = makeRepo();
    const boom = new Error("cannot reach db");
    repo.ensureMigrationsTable = async () => {
      throw boom;
    };
    const m1 = makeMigration("001");
    const runner = new MigrationRunner({} as never, repo, [m1]);

    await expect(runner.up()).rejects.toThrow("cannot reach db");
    expect(m1.upCalls).toHaveLength(0);
  });
});

describe("MigrationRunner.down()", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rolls back the most recent migration by default (count defaults to 1)", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const { runner, calls } = makeRunner(
      [m1, m2],
      [appliedRecord("001", "migration_001"), appliedRecord("002", "migration_002")],
    );

    const result = await runner.down();

    expect(result).toEqual({ success: true, applied: ["002"] });
    expect(m2.downCalls).toEqual([FAKE_CLIENT]);
    expect(m1.downCalls).toHaveLength(0);
    expect(calls.removeMigration).toHaveBeenCalledWith(FAKE_CLIENT, "002");
    expect(calls.removeMigration).not.toHaveBeenCalledWith(FAKE_CLIENT, "001");
  });

  it("rolls back multiple migrations in reverse registration order", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const { runner, calls } = makeRunner(
      [m1, m2],
      [appliedRecord("001", "migration_001"), appliedRecord("002", "migration_002")],
    );

    const result = await runner.down(2);

    expect(result).toEqual({ success: true, applied: ["002", "001"] });
    expect(calls.removeMigration).toHaveBeenNthCalledWith(1, FAKE_CLIENT, "002");
    expect(calls.removeMigration).toHaveBeenNthCalledWith(2, FAKE_CLIENT, "001");
  });

  it("ignores migrations that were never applied", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const { runner } = makeRunner([m1, m2], [appliedRecord("001", "migration_001")]);

    const result = await runner.down(2);

    expect(result).toEqual({ success: true, applied: ["001"] });
    expect(m2.downCalls).toHaveLength(0);
  });

  it("is a no-op when nothing is applied", async () => {
    const m1 = makeMigration("001");
    const { runner } = makeRunner([m1]);

    const result = await runner.down();

    expect(result).toEqual({ success: true, applied: [] });
    expect(m1.downCalls).toHaveLength(0);
  });

  it("clears the tracking record on successful rollback", async () => {
    const m1 = makeMigration("001");
    const { runner, appliedMap } = makeRunner([m1], [appliedRecord("001", "migration_001")]);

    await runner.down();

    expect(appliedMap.has("001")).toBe(false);
  });

  // ── Failure paths ────────────────────────────────────────────────────────

  it("reports the failed rollback and stops before later rollbacks", async () => {
    const m1 = makeMigration("001");
    const m2: Migration = {
      ...makeMigration("002"),
      down: async () => {
        throw new Error("cannot drop table");
      },
    };
    const { runner, appliedMap } = makeRunner(
      [m1, m2],
      [appliedRecord("001", "migration_001"), appliedRecord("002", "migration_002")],
    );

    const result = await runner.down(2);

    expect(result).toEqual({
      success: false,
      applied: [],
      failed: "002",
      error: new Error("cannot drop table"),
    } as MigrationResult);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("cannot drop table");
    // Stop-on-first-failure: 001 untouched
    expect(m1.downCalls).toHaveLength(0);
    // The failed migration's tracking record is retained
    expect(appliedMap.has("002")).toBe(true);
  });

  it("keeps the tracking record when the removal call itself throws", async () => {
    const m1 = makeMigration("001");
    const { repo } = makeRepo([appliedRecord("001", "migration_001")]);
    repo.removeMigration = async () => {
      throw new Error("delete failed");
    };
    const runner = new MigrationRunner({} as never, repo, [m1], passthroughTransact as never);

    const result = await runner.down();

    expect(result.success).toBe(false);
    expect(result.failed).toBe("001");
    expect(m1.downCalls).toHaveLength(1);
  });
});

// ─── MigrationStatus projection ──────────────────────────────────────────────

describe("MigrationRunner.status()", () => {
  it("marks migrations present in the tracking table as applied with applied_at", async () => {
    const m1 = makeMigration("001", "create_users_table");
    const { runner } = makeRunner([m1], [appliedRecord("001", "create_users_table")]);

    const statuses = await runner.status();

    expect(statuses).toEqual([
      { id: "001", name: "create_users_table", status: "applied", applied_at: appliedAt },
    ]);
  });

  it("marks missing migrations as pending with no applied_at key", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002", "add_payments");
    const { runner } = makeRunner([m1, m2], []);

    const statuses = await runner.status();

    expect(statuses).toEqual([
      { id: "001", name: "migration_001", status: "pending" },
      { id: "002", name: "add_payments", status: "pending" },
    ]);
    // applied_at must be absent (undefined), not null
    expect(statuses[0]).not.toHaveProperty("applied_at");
  });

  it("returns one status entry per registered migration, in registration order", async () => {
    const m1 = makeMigration("001");
    const m2 = makeMigration("002");
    const m3 = makeMigration("003");
    const { runner } = makeRunner(
      [m1, m2, m3],
      [appliedRecord("002", "migration_002")],
    );

    const statuses = await runner.status();

    expect(statuses.map((s) => [s.id, s.status])).toEqual([
      ["001", "pending"],
      ["002", "applied"],
      ["003", "pending"],
    ]);
  });

  it("ensures the tracking table exists as a side effect", async () => {
    const { runner, calls } = makeRunner([makeMigration("001")]);

    await runner.status();

    expect(calls.ensureMigrationsTable).toHaveBeenCalledTimes(1);
  });
});

// ─── validate(): invalid migration definitions ───────────────────────────────

describe("MigrationRunner.validate()", () => {
  it("returns valid with no errors for a well-formed migration list", async () => {
    const { runner } = makeRunner([makeMigration("001"), makeMigration("002")]);

    const result = await runner.validate();

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("detects duplicate migration IDs and reports the occurrence count", async () => {
    const a = makeMigration("001");
    const b = makeMigration("001");
    const c = makeMigration("002");
    const { runner } = makeRunner([a, b, c]);

    const result = await runner.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Duplicate migration ID "001" appears 2 times']);
  });

  it("flags migrations with empty id while keeping the name in the message", async () => {
    const bad = { ...makeMigration("001"), id: "  " };
    const { runner } = makeRunner([bad]);

    const result = await runner.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Migration has empty id (name: "migration_001")');
  });

  it("flags migrations with empty name while keeping the id in the message", async () => {
    const bad = { ...makeMigration("001"), name: "" };
    const { runner } = makeRunner([bad]);

    const result = await runner.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Migration "001" has empty name');
  });

  it("flags missing up() and down() functions with distinct messages", async () => {
    const bad = {
      id: "001",
      name: "broken",
      up: undefined as unknown as Migration["up"],
      down: undefined as unknown as Migration["down"],
    };
    const { runner } = makeRunner([bad as Migration]);

    const result = await runner.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'Migration "001" is missing an up() function',
      'Migration "001" is missing a down() function',
    ]);
  });

  it("aggregates every error across multiple invalid migrations", async () => {
    const noDown = {
      ...makeMigration("001"),
      down: undefined as unknown as Migration["down"],
    };
    const dup = makeMigration("002");
    const dup2 = makeMigration("002");
    const { runner } = makeRunner([noDown, dup, dup2]);

    const result = await runner.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors).toContain('Migration "001" is missing a down() function');
    expect(result.errors).toContain('Duplicate migration ID "002" appears 2 times');
  });

  it("does not touch the database or run any migration body during validation", async () => {
    const m1 = makeMigration("001");
    const { runner, calls } = makeRunner([m1]);

    await runner.validate();

    expect(calls.ensureMigrationsTable).not.toHaveBeenCalled();
    expect(m1.upCalls).toHaveLength(0);
    expect(m1.downCalls).toHaveLength(0);
  });

  it("returns valid for an empty migration list", async () => {
    const { runner } = makeRunner([]);

    await expect(runner.validate()).resolves.toEqual({ valid: true, errors: [] });
  });
});
