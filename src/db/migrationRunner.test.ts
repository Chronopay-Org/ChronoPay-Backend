/**
 * Focused behavior coverage for src/db/migrationRunner.ts
 *
 * The MigrationRunner is fully dependency-injected (pool, repository,
 * migrations, and the transaction helper), so every scenario below runs
 * against in-memory fakes: no PostgreSQL server required.
 *
 * Covered contract:
 *  - Migration            — the contract every migration file must export
 *  - MigrationStatus      — per-migration applied/pending report from status()
 *  - MigrationResult      — the structured result returned by up()/down()
 *  - ValidationResult     — the structured result returned by validate()
 *  - invalid inputs       — duplicate IDs, empty id/name, missing up/down
 *  - state transitions    — pending → applied (up), applied → pending (down),
 *                           stop-on-first-failure, transaction grouping
 */

import { Pool, PoolClient } from "pg";
import {
  Migration,
  MigrationResult,
  MigrationRunner,
  MigrationRepository,
  MigrationStatus,
} from "./migrationRunner.js";
import {
  AppliedMigration,
  QueryClient,
} from "./migrationRepository.js";

// ─── Test fakes ───────────────────────────────────────────────────────────────

/** Minimal PoolClient stand-in passed to migration up()/down() callbacks. */
const fakeClient = {
  query: async () => ({ rows: [], rowCount: null }),
} as unknown as PoolClient;

type FakePool = Pool;

function makeFakePool(): FakePool {
  return { query: async () => ({ rows: [], rowCount: null }) } as unknown as Pool;
}

/**
 * In-memory migration repository. Tracks table bootstrap, applied rows, and
 * the recorded id/name pairs so tests can observe exactly what the runner
 * wrote inside each transaction.
 */
class FakeMigrationRepository implements MigrationRepository {
  public rows = new Map<string, AppliedMigration>();
  public ensureMigrationsTableCalls = 0;
  public recorded: Array<{ id: string; name: string }> = [];
  public removed: string[] = [];

  async ensureMigrationsTable(_client: QueryClient): Promise<void> {
    this.ensureMigrationsTableCalls += 1;
  }

  async getAppliedMigrations(_client: QueryClient): Promise<AppliedMigration[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async recordMigration(_client: QueryClient, id: string, name: string): Promise<void> {
    this.recorded.push({ id, name });
    this.rows.set(id, { id, name, applied_at: new Date("2024-01-01T00:00:00Z") });
  }

  async removeMigration(_client: QueryClient, id: string): Promise<void> {
    this.removed.push(id);
    this.rows.delete(id);
  }
}

/** Deterministic, ordered transaction spy standing in for withTransaction. */
class FakeTransactionRunner {
  public calls: Array<{ committed: boolean; client: PoolClient }> = [];
  /** When set, the next executed transaction rejects with this error. */
  public failNextWith?: Error;

  async run<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = undefined;
      throw err;
    }
    const client = fakeClient;
    await fn(client);
    this.calls.push({ committed: true, client });
    return undefined as T;
  }
}

interface MigrationFixture {
  id: string;
  name?: string;
  up?: Migration["up"] | null;
  down?: Migration["down"] | null;
  upError?: Error;
  downError?: Error;
}

function makeMigration(fixture: MigrationFixture): Migration {
  const migration = {
    id: fixture.id,
    name: fixture.name ?? `migration_${fixture.id}`,
  } as Migration;

  if (fixture.up !== null) {
    migration.up = async (client: PoolClient): Promise<void> => {
      void client;
      if (fixture.upError) throw fixture.upError;
    };
  }
  if (fixture.down !== null) {
    migration.down = async (client: PoolClient): Promise<void> => {
      void client;
      if (fixture.downError) throw fixture.downError;
    };
  }
  return migration;
}

function makeRunner(
  migrations: Migration[],
  repo: FakeMigrationRepository,
  transact?: FakeTransactionRunner["run"],
): { runner: MigrationRunner; transactor: FakeTransactionRunner } {
  const transactor = new FakeTransactionRunner();
  const runner = new MigrationRunner(
    makeFakePool(),
    repo,
    migrations,
    transact ?? transactor.run.bind(transactor),
  );
  return { runner, transactor };
}

// ─── validate(): structural validation of Migration definitions ──────────────

describe("MigrationRunner.validate", () => {
  test("returns valid=true for well-formed migrations and empty errors", async () => {
    const { runner } = makeRunner(
      [makeMigration({ id: "001" }), makeMigration({ id: "002", name: "create_slots" })],
      new FakeMigrationRepository(),
    );

    const result = await runner.validate();

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("detects duplicate IDs and reports occurrence count", async () => {
    const { runner } = makeRunner(
      [makeMigration({ id: "001" }), makeMigration({ id: "001" }), makeMigration({ id: "001" })],
      new FakeMigrationRepository(),
    );

    const result = await runner.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Duplicate migration ID "001" appears 3 times']);
  });

  test("reports empty and whitespace-only ids with the migration name", async () => {
    const { runner } = makeRunner(
      [
        makeMigration({ id: "", name: "no_id" }),
        makeMigration({ id: "   ", name: "blank_id" }),
      ],
      new FakeMigrationRepository(),
    );

    const result = await runner.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'Migration has empty id (name: "no_id")',
      'Migration has empty id (name: "blank_id")',
    ]);
  });

  test("reports empty and whitespace-only names", async () => {
    const { runner } = makeRunner(
      [
        makeMigration({ id: "001", name: "" }),
        makeMigration({ id: "002", name: "   " }),
      ],
      new FakeMigrationRepository(),
    );

    const result = await runner.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'Migration "001" has empty name',
      'Migration "002" has empty name',
    ]);
  });

  test("reports missing up() and down() functions", async () => {
    const { runner } = makeRunner(
      [
        makeMigration({ id: "001", up: null }),
        makeMigration({ id: "002", up: null, down: null }),
        makeMigration({ id: "003", down: null }),
      ],
      new FakeMigrationRepository(),
    );

    const result = await runner.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'Migration "001" is missing an up() function',
      'Migration "002" is missing an up() function',
      'Migration "002" is missing a down() function',
      'Migration "003" is missing a down() function',
    ]);
  });

  test("aggregates multiple defects on the same migration without losing any", async () => {
    const { runner } = makeRunner([makeMigration({ id: "", name: "" })], new FakeMigrationRepository());

    const result = await runner.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'Migration has empty id (name: "")',
      'Migration "" has empty name',
    ]);
  });

  test("does not touch the database or ensure the tracking table", async () => {
    const repo = new FakeMigrationRepository();
    const { runner } = makeRunner([makeMigration({ id: "001" })], repo);

    await runner.validate();

    expect(repo.ensureMigrationsTableCalls).toBe(0);
  });

  test("validate() on an empty migration list is valid", async () => {
    const { runner } = makeRunner([], new FakeMigrationRepository());

    const result = await runner.validate();

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ─── status(): MigrationStatus reporting ──────────────────────────────────────

describe("MigrationRunner.status", () => {
  test("ensures the tracking table and reports every migration as pending when none applied", async () => {
    const repo = new FakeMigrationRepository();
    const { runner } = makeRunner(
      [makeMigration({ id: "001" }), makeMigration({ id: "002" })],
      repo,
    );

    const statuses: MigrationStatus[] = await runner.status();

    expect(repo.ensureMigrationsTableCalls).toBe(1);
    expect(statuses).toEqual([
      { id: "001", name: "migration_001", status: "pending" },
      { id: "002", name: "migration_002", status: "pending" },
    ]);
  });

  test("marks applied migrations with applied_at from the tracking table", async () => {
    const repo = new FakeMigrationRepository();
    const appliedAt = new Date("2024-06-01T12:00:00Z");
    repo.rows.set("001", { id: "001", name: "migration_001", applied_at: appliedAt });
    const { runner } = makeRunner(
      [makeMigration({ id: "001" }), makeMigration({ id: "002" })],
      repo,
    );

    const statuses: MigrationStatus[] = await runner.status();

    expect(statuses).toEqual([
      { id: "001", name: "migration_001", status: "applied", applied_at: appliedAt },
      { id: "002", name: "migration_002", status: "pending" },
    ]);
  });

  test("preserves registration order rather than tracking-table order", async () => {
    const repo = new FakeMigrationRepository();
    repo.rows.set("001", { id: "001", name: "migration_001", applied_at: new Date() });
    repo.rows.set("002", { id: "002", name: "migration_002", applied_at: new Date() });
    const { runner } = makeRunner(
      [makeMigration({ id: "002" }), makeMigration({ id: "001" })],
      repo,
    );

    const statuses = await runner.status();

    expect(statuses.map((s) => s.id)).toEqual(["002", "001"]);
  });

  test("ignores tracking rows for unregistered migrations", async () => {
    const repo = new FakeMigrationRepository();
    repo.rows.set("999", { id: "999", name: "ghost", applied_at: new Date() });
    const { runner } = makeRunner([makeMigration({ id: "001" })], repo);

    const statuses = await runner.status();

    expect(statuses).toEqual([{ id: "001", name: "migration_001", status: "pending" }]);
  });
});

// ─── up(): pending → applied transitions ─────────────────────────────────────

describe("MigrationRunner.up", () => {
  test("applies all pending migrations in registration order and records them", async () => {
    const repo = new FakeMigrationRepository();
    const appliedSql: string[] = [];
    const m1 = makeMigration({ id: "001" });
    const m2 = makeMigration({ id: "002" });
    m1.up = async () => {
      appliedSql.push("001");
    };
    m2.up = async () => {
      appliedSql.push("002");
    };
    const { runner, transactor } = makeRunner([m1, m2], repo);

    const result: MigrationResult = await runner.up();

    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["001", "002"]);
    expect(result.failed).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(appliedSql).toEqual(["001", "002"]);
    expect(repo.recorded).toEqual([
      { id: "001", name: "migration_001" },
      { id: "002", name: "migration_002" },
    ]);
    expect([...repo.rows.keys()]).toEqual(["001", "002"]);
    expect(transactor.calls).toHaveLength(2);
  });

  test("is idempotent: already-applied migrations are skipped entirely", async () => {
    const repo = new FakeMigrationRepository();
    repo.rows.set("001", { id: "001", name: "migration_001", applied_at: new Date() });
    const upCalls: string[] = [];
    const m1 = makeMigration({ id: "001" });
    const m2 = makeMigration({ id: "002" });
    m1.up = async () => {
      upCalls.push("001");
    };
    m2.up = async () => {
      upCalls.push("002");
    };
    const { runner } = makeRunner([m1, m2], repo);

    const result = await runner.up();

    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["002"]);
    expect(upCalls).toEqual(["002"]);
    expect(repo.recorded).toEqual([{ id: "002", name: "migration_002" }]);
  });

  test("honors the count limit, taking the first N pending migrations", async () => {
    const repo = new FakeMigrationRepository();
    const m1 = makeMigration({ id: "001" });
    const m2 = makeMigration({ id: "002" });
    const m3 = makeMigration({ id: "003" });
    const { runner } = makeRunner([m1, m2, m3], repo);

    const result = await runner.up(2);

    expect(result.applied).toEqual(["001", "002"]);
    expect([...repo.rows.keys()]).toEqual(["001", "002"]);
  });

  test("returns success with empty applied list when nothing is pending", async () => {
    const repo = new FakeMigrationRepository();
    repo.rows.set("001", { id: "001", name: "migration_001", applied_at: new Date() });
    const { runner } = makeRunner([makeMigration({ id: "001" })], repo);

    const result = await runner.up();

    expect(result).toEqual({ success: true, applied: [] });
    expect(repo.recorded).toEqual([]);
  });

  test("count=0 applies nothing", async () => {
    const repo = new FakeMigrationRepository();
    const { runner } = makeRunner([makeMigration({ id: "001" })], repo);

    const result = await runner.up(0);

    expect(result).toEqual({ success: true, applied: [] });
    expect(repo.recorded).toEqual([]);
  });

  test("count larger than pending applies only what is pending", async () => {
    const repo = new FakeMigrationRepository();
    const { runner } = makeRunner(
      [makeMigration({ id: "001" }), makeMigration({ id: "002" })],
      repo,
    );

    const result = await runner.up(10);

    expect(result.applied).toEqual(["001", "002"]);
  });

  test("applies pending migrations around already-applied ones", async () => {
    const repo = new FakeMigrationRepository();
    repo.rows.set("002", { id: "002", name: "migration_002", applied_at: new Date() });
    const { runner } = makeRunner(
      [makeMigration({ id: "001" }), makeMigration({ id: "002" }), makeMigration({ id: "003" })],
      repo,
    );

    const result = await runner.up();

    expect(result.applied).toEqual(["001", "003"]);
  });

  test("runs migration.up and recordMigration inside the SAME transaction", async () => {
    const repo = new FakeMigrationRepository();
    const operationOrder: string[] = [];
    const m = makeMigration({ id: "001" });
    m.up = async () => {
      operationOrder.push("up");
    };
    const recordMigration = repo.recordMigration.bind(repo);
    repo.recordMigration = async (client: QueryClient, id: string, name: string) => {
      operationOrder.push("record");
      await recordMigration(client, id, name);
    };
    const { runner, transactor } = makeRunner([m], repo);

    await runner.up();

    expect(operationOrder).toEqual(["up", "record"]);
    expect(transactor.calls).toHaveLength(1);
  });

  test("stop-on-first-failure: marks failed, reports error, and skips later migrations", async () => {
    const repo = new FakeMigrationRepository();
    const boom = new Error("constraint violation");
    const upCalls: string[] = [];
    const m1 = makeMigration({ id: "001" });
    const m2 = makeMigration({ id: "002", upError: boom });
    const m3 = makeMigration({ id: "003" });
    m1.up = async () => {
      upCalls.push("001");
    };
    m2.up = async () => {
      upCalls.push("002");
      throw boom;
    };
    m3.up = async () => {
      upCalls.push("003");
    };
    const { runner, transactor } = makeRunner([m1, m2, m3], repo);

    const result = await runner.up();

    expect(result.success).toBe(false);
    expect(result.applied).toEqual(["001"]);
    expect(result.failed).toBe("002");
    expect(result.error).toBe(boom);
    expect(upCalls).toEqual(["001", "002"]);
    expect(repo.recorded).toEqual([{ id: "001", name: "migration_001" }]);
    expect([...repo.rows.keys()]).toEqual(["001"]);
    expect(transactor.calls).toHaveLength(1);
  });

  test("does not record the tracking row when up() itself throws", async () => {
    const repo = new FakeMigrationRepository();
    const m = makeMigration({ id: "001", upError: new Error("syntax error") });
    const { runner } = makeRunner([m], repo);

    const result = await runner.up();

    expect(result.success).toBe(false);
    expect(result.failed).toBe("001");
    expect(repo.recorded).toEqual([]);
    expect([...repo.rows.keys()]).toEqual([]);
  });

  test("wraps non-Error rejections from the transaction in a real Error", async () => {
    const fakeRepo = new FakeMigrationRepository();
    const failingTransact = async (_fn: (client: PoolClient) => Promise<void>): Promise<void> => {
      throw "rollback string failure"; // non-Error throw
    };
    const { runner } = makeRunner([makeMigration({ id: "001" })], fakeRepo, failingTransact);

    const result = await runner.up();

    expect(result.success).toBe(false);
    expect(result.failed).toBe("001");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("rollback string failure");
  });

  test("propagates repository failures (e.g. ensureMigrationsTable) — not swallowed as MigrationResult", async () => {
    const repo = new FakeMigrationRepository();
    repo.ensureMigrationsTable = async () => {
      throw new Error("cannot reach database");
    };
    const { runner } = makeRunner([makeMigration({ id: "001" })], repo);

    await expect(runner.up()).rejects.toThrow("cannot reach database");
  });
});

// ─── down(): applied → pending transitions ───────────────────────────────────

describe("MigrationRunner.down", () => {
  test("rolls back the most recent applied migration by default (count=1)", async () => {
    const repo = new FakeMigrationRepository();
    repo.rows.set("001", { id: "001", name: "migration_001", applied_at: new Date() });
    repo.rows.set("002", { id: "002", name: "migration_002", applied_at: new Date() });
    const downCalls: string[] = [];
    const m1 = makeMigration({ id: "001" });
    const m2 = makeMigration({ id: "002" });
    m1.down = async () => {
      downCalls.push("001");
    };
    m2.down = async () => {
      downCalls.push("002");
    };
    const { runner } = makeRunner([m1, m2], repo);

    const result = await runner.down();

    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["002"]);
    expect(downCalls).toEqual(["002"]);
    expect(repo.removed).toEqual(["002"]);
    expect([...repo.rows.keys()]).toEqual(["001"]);
  });

  test("rolls back multiple migrations in reverse registration order", async () => {
    const repo = new FakeMigrationRepository();
    repo.rows.set("001", { id: "001", name: "migration_001", applied_at: new Date() });
    repo.rows.set("002", { id: "002", name: "migration_002", applied_at: new Date() });
    repo.rows.set("003", { id: "003", name: "migration_003", applied_at: new Date() });
    const downCalls: string[] = [];
    const m1 = makeMigration({ id: "001" });
    const m2 = makeMigration({ id: "002" });
    const m3 = makeMigration({ id: "003" });
    m1.down = async () => {
      downCalls.push("001");
    };
    m2.down = async () => {
      downCalls.push("002");
    };
    m3.down = async () => {
      downCalls.push("003");
    };
    const { runner } = makeRunner([m1, m2, m3], repo);

    const result = await runner.down(2);

    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["003", "002"]);
    expect(downCalls).toEqual(["003", "002"]);
    expect(repo.removed).toEqual(["003", "002"]);
  });

  test("only considers applied migrations when choosing rollbacks", async () => {
    const repo = new FakeMigrationRepository();
    repo.rows.set("001", { id: "001", name: "migration_001", applied_at: new Date() });
    const { runner } = makeRunner(
      [makeMigration({ id: "001" }), makeMigration({ id: "002" })],
      repo,
    );

    const result = await runner.down(5);

    expect(result.applied).toEqual(["001"]);
    expect(repo.removed).toEqual(["001"]);
  });

  test("down() on a fresh database is a no-op success", async () => {
    const repo = new FakeMigrationRepository();
    const { runner } = makeRunner([makeMigration({ id: "001" })], repo);

    const result = await runner.down();

    expect(result).toEqual({ success: true, applied: [] });
    expect(repo.removed).toEqual([]);
  });

  test("rolls back nothing for applied-but-unregistered migration ids", async () => {
    const repo = new FakeMigrationRepository();
    repo.rows.set("999", { id: "999", name: "ghost", applied_at: new Date() });
    const { runner } = makeRunner([makeMigration({ id: "001" })], repo);

    const result = await runner.down();

    expect(result.success).toBe(true);
    expect(result.applied).toEqual([]);
    expect(repo.removed).toEqual([]);
  });

  test("runs migration.down and removeMigration inside the SAME transaction", async () => {
    const repo = new FakeMigrationRepository();
    const operationOrder: string[] = [];
    const m = makeMigration({ id: "001" });
    repo.rows.set("001", { id: "001", name: "migration_001", applied_at: new Date() });
    m.down = async () => {
      operationOrder.push("down");
    };
    const removeMigration = repo.removeMigration.bind(repo);
    repo.removeMigration = async (client: QueryClient, id: string) => {
      operationOrder.push("remove");
      await removeMigration(client, id);
    };
    const { runner, transactor } = makeRunner([m], repo);

    await runner.down();

    expect(operationOrder).toEqual(["down", "remove"]);
    expect(transactor.calls).toHaveLength(1);
  });

  test("stop-on-first-failure: stops after a failing down() and leaves earlier migrations applied", async () => {
    const repo = new FakeMigrationRepository();
    repo.rows.set("001", { id: "001", name: "migration_001", applied_at: new Date() });
    repo.rows.set("002", { id: "002", name: "migration_002", applied_at: new Date() });
    const boom = new Error("cannot drop column");
    const downCalls: string[] = [];
    const m1 = makeMigration({ id: "001" });
    const m2 = makeMigration({ id: "002", downError: boom });
    m2.down = async () => {
      downCalls.push("002");
      throw boom;
    };
    const { runner } = makeRunner([m1, m2], repo);

    const result = await runner.down(2);

    expect(result.success).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.failed).toBe("002");
    expect(result.error).toBe(boom);
    expect(downCalls).toEqual(["002"]);
    expect(repo.removed).toEqual([]);
    expect([...repo.rows.keys()].sort()).toEqual(["001", "002"]);
  });

  test("does not remove the tracking row when down() itself throws", async () => {
    const repo = new FakeMigrationRepository();
    repo.rows.set("001", { id: "001", name: "migration_001", applied_at: new Date() });
    const m = makeMigration({ id: "001", downError: new Error("drop failed") });
    const { runner } = makeRunner([m], repo);

    const result = await runner.down();

    expect(result.success).toBe(false);
    expect(result.failed).toBe("001");
    expect(repo.removed).toEqual([]);
    expect([...repo.rows.keys()]).toEqual(["001"]);
  });

  test("propagates repository failures during down() — not swallowed", async () => {
    const repo = new FakeMigrationRepository();
    repo.ensureMigrationsTable = async () => {
      throw new Error("connection refused");
    };
    const { runner } = makeRunner([makeMigration({ id: "001" })], repo);

    await expect(runner.down()).rejects.toThrow("connection refused");
  });
});

// ─── Round-trip: full state machine pending ⇄ applied ─────────────────────────

describe("MigrationRunner state transitions (round trip)", () => {
  test("status reflects pending → applied → pending across up() and down()", async () => {
    const repo = new FakeMigrationRepository();
    const { runner } = makeRunner(
      [makeMigration({ id: "001" }), makeMigration({ id: "002" })],
      repo,
    );

    const before = await runner.status();
    expect(before.map((s) => s.status)).toEqual(["pending", "pending"]);

    await runner.up();

    const afterUp = await runner.status();
    expect(afterUp.map((s) => s.status)).toEqual(["applied", "applied"]);
    expect(afterUp.every((s) => s.applied_at instanceof Date)).toBe(true);

    await runner.down(2);

    const afterDown = await runner.status();
    expect(afterDown.map((s) => s.status)).toEqual(["pending", "pending"]);
  });

  test("up() is safe to run twice — second run applies nothing", async () => {
    const repo = new FakeMigrationRepository();
    const { runner } = makeRunner([makeMigration({ id: "001" })], repo);

    const first = await runner.up();
    const second = await runner.up();

    expect(first.applied).toEqual(["001"]);
    expect(second).toEqual({ success: true, applied: [] });
    expect(repo.recorded).toHaveLength(1);
  });

  test("partial up(count) followed by up() completes the remaining migrations", async () => {
    const repo = new FakeMigrationRepository();
    const { runner } = makeRunner(
      [makeMigration({ id: "001" }), makeMigration({ id: "002" }), makeMigration({ id: "003" })],
      repo,
    );

    const first = await runner.up(1);
    expect(first.applied).toEqual(["001"]);

    const second = await runner.up();
    expect(second.applied).toEqual(["002", "003"]);

    const statuses = await runner.status();
    expect(statuses.map((s) => s.status)).toEqual(["applied", "applied", "applied"]);
  });

  test("failed up() followed by retry applies only the failed migration", async () => {
    const repo = new FakeMigrationRepository();
    let failSecond = true;
    const m1 = makeMigration({ id: "001" });
    const m2 = makeMigration({ id: "002" });
    m2.up = async () => {
      if (failSecond) throw new Error("transient failure");
    };
    const { runner } = makeRunner([m1, m2], repo);

    const first = await runner.up();
    expect(first.success).toBe(false);
    expect(first.failed).toBe("002");
    expect(first.applied).toEqual(["001"]);

    failSecond = false;
    const retry = await runner.up();
    expect(retry.success).toBe(true);
    expect(retry.applied).toEqual(["002"]);
    expect([...repo.rows.keys()].sort()).toEqual(["001", "002"]);
  });
});
