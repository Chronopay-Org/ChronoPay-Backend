/**
 * Tests for src/db/migrationRunner.ts
 *
 * No module mocking needed. MigrationRunner accepts `transact` as an optional
 * 4th constructor argument, so we inject a jest.fn() directly. This avoids
 * all ESM jest.mock() hoisting issues while keeping full isolation.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { Pool, PoolClient } from "pg";
import {
  MigrationRunner,
  Migration,
  MigrationRepository,
} from "../../db/migrationRunner.js";
import type { AppliedMigration } from "../../db/migrationRepository.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const mockPool = {} as Pool;
const mockClient = {} as PoolClient;

// Injected transaction helper — calls fn(mockClient) synchronously
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTransact = jest.fn<any>().mockImplementation(
  <T>(fn: (c: PoolClient) => Promise<T>) => fn(mockClient),
);

/** Create a mock migration with controllable up/down functions. */
function makeMigration(id: string, name: string): Migration {
  return {
    id,
    name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    up: jest.fn<any>().mockResolvedValue(undefined) as Migration["up"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    down: jest.fn<any>().mockResolvedValue(undefined) as Migration["down"],
  };
}

const makeMockMigrations = (): Migration[] => [
  makeMigration("001", "create_users_table"),
  makeMigration("002", "create_slots_table"),
];

/** Create a fully mocked MigrationRepository. */
function makeMockRepo(): MigrationRepository {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureMigrationsTable: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAppliedMigrations: jest.fn<any>().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recordMigration: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeMigration: jest.fn<any>().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Restore the default transact behavior after clearAllMocks
  mockTransact.mockImplementation(<T>(fn: (c: PoolClient) => Promise<T>) => fn(mockClient));
});

// ─── validate() ───────────────────────────────────────────────────────────────

describe("validate()", () => {
  it("returns valid=true for a well-formed migration list", async () => {
    const runner = new MigrationRunner(mockPool, makeMockRepo(), makeMockMigrations(), mockTransact);
    const result = await runner.validate();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns valid=false with error for duplicate IDs", async () => {
    const migrations = [makeMigration("001", "a"), makeMigration("001", "b")];
    const runner = new MigrationRunner(mockPool, makeMockRepo(), migrations, mockTransact);
    const result = await runner.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("001"))).toBe(true);
  });

  it("returns error for empty id", async () => {
    const runner = new MigrationRunner(
      mockPool, makeMockRepo(), [makeMigration("", "empty")], mockTransact,
    );
    const result = await runner.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("empty id"))).toBe(true);
  });

  it("returns error for empty name", async () => {
    const runner = new MigrationRunner(
      mockPool, makeMockRepo(), [makeMigration("001", "")], mockTransact,
    );
    const result = await runner.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("empty name"))).toBe(true);
  });

  it("returns error for missing up function", async () => {
    const m = makeMigration("001", "bad");
    (m as unknown as Record<string, unknown>).up = undefined;
    const runner = new MigrationRunner(mockPool, makeMockRepo(), [m], mockTransact);
    const result = await runner.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("up()"))).toBe(true);
  });

  it("returns error for missing down function", async () => {
    const m = makeMigration("001", "bad");
    (m as unknown as Record<string, unknown>).down = undefined;
    const runner = new MigrationRunner(mockPool, makeMockRepo(), [m], mockTransact);
    const result = await runner.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("down()"))).toBe(true);
  });

  it("collects multiple errors in a single result", async () => {
    const migrations = [
      makeMigration("001", "a"),
      makeMigration("001", "b"), // duplicate
      makeMigration("003", ""),  // empty name
    ];
    const runner = new MigrationRunner(mockPool, makeMockRepo(), migrations, mockTransact);
    const result = await runner.validate();
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

// ─── status() ────────────────────────────────────────────────────────────────

describe("status()", () => {
  it("calls ensureMigrationsTable before querying", async () => {
    const repo = makeMockRepo();
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);
    await runner.status();
    expect(jest.mocked(repo.ensureMigrationsTable)).toHaveBeenCalledWith(mockPool);
  });

  it("returns all migrations as pending when none are applied", async () => {
    const repo = makeMockRepo();
    jest.mocked(repo.getAppliedMigrations).mockResolvedValue([]);
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);
    const result = await runner.status();
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.status === "pending")).toBe(true);
  });

  it("marks applied migrations with correct status and applied_at", async () => {
    const now = new Date();
    const applied: AppliedMigration[] = [
      { id: "001", name: "create_users_table", applied_at: now },
    ];
    const repo = makeMockRepo();
    jest.mocked(repo.getAppliedMigrations).mockResolvedValue(applied);
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);

    const result = await runner.status();
    expect(result[0].status).toBe("applied");
    expect(result[0].applied_at).toBe(now);
    expect(result[1].status).toBe("pending");
  });

  it("preserves the source order of the migration list", async () => {
    const repo = makeMockRepo();
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);
    const result = await runner.status();
    expect(result.map((s) => s.id)).toEqual(["001", "002"]);
  });
});

// ─── up() ────────────────────────────────────────────────────────────────────

describe("up()", () => {
  it("applies all pending migrations when no count is given", async () => {
    const repo = makeMockRepo();
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);
    const result = await runner.up();
    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["001", "002"]);
  });

  it("applies only `count` pending migrations when count is specified", async () => {
    const repo = makeMockRepo();
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);
    const result = await runner.up(1);
    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["001"]);
  });

  it("skips already-applied migrations", async () => {
    const repo = makeMockRepo();
    jest.mocked(repo.getAppliedMigrations).mockResolvedValue([
      { id: "001", name: "create_users_table", applied_at: new Date() },
    ]);
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);
    const result = await runner.up();
    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["002"]);
  });

  it("is a no-op and returns success when all migrations are already applied", async () => {
    const repo = makeMockRepo();
    jest.mocked(repo.getAppliedMigrations).mockResolvedValue([
      { id: "001", name: "create_users_table", applied_at: new Date() },
      { id: "002", name: "create_slots_table", applied_at: new Date() },
    ]);
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);
    const result = await runner.up();
    expect(result.success).toBe(true);
    expect(result.applied).toHaveLength(0);
  });

  it("calls recordMigration inside the same transaction as up()", async () => {
    const repo = makeMockRepo();
    const migrations = makeMockMigrations();
    const runner = new MigrationRunner(mockPool, repo, migrations, mockTransact);

    await runner.up(1);

    expect(migrations[0].up).toHaveBeenCalledWith(mockClient);
    expect(jest.mocked(repo.recordMigration)).toHaveBeenCalledWith(
      mockClient, "001", "create_users_table",
    );
  });

  it("stops on first failure and reports the failed migration ID", async () => {
    const repo = makeMockRepo();
    const migrations = makeMockMigrations();
    jest.mocked(migrations[0].up).mockImplementationOnce(() =>
      Promise.reject(new Error("syntax error")),
    );

    const runner = new MigrationRunner(mockPool, repo, migrations, mockTransact);
    const result = await runner.up();

    expect(result.success).toBe(false);
    expect(result.failed).toBe("001");
    expect(result.error?.message).toBe("syntax error");
    expect(migrations[1].up).not.toHaveBeenCalled();
    expect(result.applied).toHaveLength(0);
  });

  it("wraps each migration in the transact function", async () => {
    const repo = makeMockRepo();
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);
    await runner.up();
    expect(mockTransact).toHaveBeenCalledTimes(2);
  });
});

// ─── down() ──────────────────────────────────────────────────────────────────

describe("down()", () => {
  it("rolls back the most recently applied migration by default (count=1)", async () => {
    const repo = makeMockRepo();
    jest.mocked(repo.getAppliedMigrations).mockResolvedValue([
      { id: "001", name: "create_users_table", applied_at: new Date() },
      { id: "002", name: "create_slots_table", applied_at: new Date() },
    ]);
    const migrations = makeMockMigrations();
    const runner = new MigrationRunner(mockPool, repo, migrations, mockTransact);

    const result = await runner.down();
    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["002"]);
    expect(migrations[0].down).not.toHaveBeenCalled();
  });

  it("rolls back `count` migrations in reverse order", async () => {
    const repo = makeMockRepo();
    jest.mocked(repo.getAppliedMigrations).mockResolvedValue([
      { id: "001", name: "create_users_table", applied_at: new Date() },
      { id: "002", name: "create_slots_table", applied_at: new Date() },
    ]);
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);
    const result = await runner.down(2);
    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["002", "001"]);
  });

  it("is a no-op when no migrations have been applied", async () => {
    const repo = makeMockRepo();
    jest.mocked(repo.getAppliedMigrations).mockResolvedValue([]);
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);
    const result = await runner.down();
    expect(result.success).toBe(true);
    expect(result.applied).toHaveLength(0);
  });

  it("calls removeMigration inside the same transaction as down()", async () => {
    const repo = makeMockRepo();
    jest.mocked(repo.getAppliedMigrations).mockResolvedValue([
      { id: "002", name: "create_slots_table", applied_at: new Date() },
    ]);
    const migrations = makeMockMigrations();
    const runner = new MigrationRunner(mockPool, repo, migrations, mockTransact);

    await runner.down(1);
    expect(migrations[1].down).toHaveBeenCalledWith(mockClient);
    expect(jest.mocked(repo.removeMigration)).toHaveBeenCalledWith(mockClient, "002");
  });

  it("stops on first failure and reports the failed migration ID", async () => {
    const repo = makeMockRepo();
    jest.mocked(repo.getAppliedMigrations).mockResolvedValue([
      { id: "001", name: "create_users_table", applied_at: new Date() },
      { id: "002", name: "create_slots_table", applied_at: new Date() },
    ]);
    const migrations = makeMockMigrations();
    jest.mocked(migrations[1].down).mockImplementationOnce(() =>
      Promise.reject(new Error("drop failed")),
    );

    const runner = new MigrationRunner(mockPool, repo, migrations, mockTransact);
    const result = await runner.down(2);

    expect(result.success).toBe(false);
    expect(result.failed).toBe("002");
    expect(result.error?.message).toBe("drop failed");
    expect(migrations[0].down).not.toHaveBeenCalled();
  });

  it("wraps each rollback in the transact function", async () => {
    const repo = makeMockRepo();
    jest.mocked(repo.getAppliedMigrations).mockResolvedValue([
      { id: "001", name: "create_users_table", applied_at: new Date() },
      { id: "002", name: "create_slots_table", applied_at: new Date() },
    ]);
    const runner = new MigrationRunner(mockPool, repo, makeMockMigrations(), mockTransact);
    await runner.down(2);
    expect(mockTransact).toHaveBeenCalledTimes(2);
  });
});
