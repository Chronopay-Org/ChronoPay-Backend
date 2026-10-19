/**
 * Regression suite for src/db/pool.ts.
 *
 * Focus: the failure-handling contracts called out by the issue —
 *  - `closePool()` must surface a `pool.end()` rejection instead of swallowing it
 *  - `initDB()` must wrap connection failures with a deterministic message
 *  - the query wrapper must translate a statement_timeout cancellation (57014)
 *    into a `QueryBudgetExceededError`, and must NOT mislabel other failures
 *
 * This project runs Jest in ESM mode, where `jest.mock()` cannot intercept
 * static imports, so the metrics/logger-heavy connection layer is replaced with
 * `jest.unstable_mockModule()` and the module under test is loaded dynamically.
 */

import { jest, describe, it, expect, beforeAll, afterEach } from "@jest/globals";
import type { QueryResult, Pool } from "pg";

type ClosePool = () => Promise<void>;
type InitDB = () => Promise<void>;
type Query = (text: string, params?: unknown[]) => Promise<QueryResult>;
type RunWithQueryBudget = <T>(
  context: { budgetMs: number; totalSqlTimeMs: number; route: string; breached: boolean },
  fn: () => T,
) => T;

let pool: Pool;
let closePool: ClosePool;
let initDB: InitDB;
let query: Query;
let runWithQueryBudget: RunWithQueryBudget;
let recordBudgetBreach: jest.Mock;

jest.unstable_mockModule("../../db/connection.js", () => ({
  _recordBudgetBreach: jest.fn(),
  isStatementTimeoutError: (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === "57014",
}));

beforeAll(async () => {
  const poolModule = await import("../../db/pool.js");
  const budgetModule = await import("../../db/queryBudgetContext.js");
  const connectionModule = await import("../../db/connection.js");

  pool = poolModule.default;
  closePool = poolModule.closePool;
  initDB = poolModule.initDB;
  query = poolModule.query;
  runWithQueryBudget = budgetModule.runWithQueryBudget as RunWithQueryBudget;
  recordBudgetBreach = connectionModule._recordBudgetBreach as unknown as jest.Mock;
});

const poolEnd = () => jest.spyOn(pool, "end") as unknown as jest.Mock;
const poolQuery = () => jest.spyOn(pool, "query") as unknown as jest.Mock;

function ok(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── closePool ───────────────────────────────────────────────────────────────

describe("closePool()", () => {
  it("resolves and drains the shared pool exactly once on the normal path", async () => {
    const end = poolEnd().mockResolvedValue(undefined);

    await expect(closePool()).resolves.toBeUndefined();

    expect(end).toHaveBeenCalledTimes(1);
  });

  it("propagates a pool.end() failure instead of swallowing it", async () => {
    const failure = new Error("terminating connection due to administrator command");
    const end = poolEnd().mockRejectedValueOnce(failure);

    await expect(closePool()).rejects.toBe(failure);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("logs the shutdown lifecycle outside the test environment", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    poolEnd().mockResolvedValue(undefined);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      await closePool();
      expect(log).toHaveBeenCalledWith("Closing PostgreSQL connection pool...");
      expect(log).toHaveBeenCalledWith("PostgreSQL connection pool closed.");
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("stays silent in the test environment", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    poolEnd().mockResolvedValue(undefined);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";

    try {
      await closePool();
      expect(log).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

// ─── initDB ──────────────────────────────────────────────────────────────────

describe("initDB()", () => {
  it("runs the connectivity probe", async () => {
    const q = poolQuery().mockResolvedValueOnce(ok([{ connected: 1 }]));

    await expect(initDB()).resolves.toBeUndefined();
    expect(q).toHaveBeenCalledWith("SELECT 1 AS connected");
  });

  it("wraps a connection failure with a deterministic, prefixed message", async () => {
    poolQuery().mockRejectedValueOnce(new Error("connection refused"));

    await expect(initDB()).rejects.toThrow(
      "Database connection failed: connection refused",
    );
  });

  it("reports 'Unknown error' when the rejection is not an Error", async () => {
    poolQuery().mockRejectedValueOnce("socket hang up");

    await expect(initDB()).rejects.toThrow(
      "Database connection failed: Unknown error",
    );
  });
});

// ─── query wrapper ───────────────────────────────────────────────────────────

describe("query()", () => {
  it("returns the underlying result and forwards parameters when no budget is active", async () => {
    const result = ok([{ id: 1 }]);
    const q = poolQuery().mockResolvedValueOnce(result);

    await expect(query("SELECT $1 AS id", [1])).resolves.toBe(result);
    expect(q).toHaveBeenCalledWith("SELECT $1 AS id", [1]);
  });

  it("re-throws an unrelated database error unchanged", async () => {
    const boom = new Error('syntax error at or near "SELEC"');
    poolQuery().mockRejectedValueOnce(boom);

    await expect(query("SELEC 1")).rejects.toBe(boom);
  });

  it("translates a 57014 cancellation into a budget-exceeded error and records the breach", async () => {
    const q = poolQuery();
    q.mockResolvedValueOnce(ok()); // SET LOCAL statement_timeout
    const cancelled = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    q.mockRejectedValueOnce(cancelled);

    await runWithQueryBudget(
      { budgetMs: 50, totalSqlTimeMs: 0, route: "/api/v1/checkout", breached: false },
      async () => {
        await expect(query("SELECT pg_sleep(10)")).rejects.toThrow(/Query budget exceeded/);
      },
    );

    expect(recordBudgetBreach).toHaveBeenCalledTimes(1);
    expect(q).toHaveBeenCalledWith("SET LOCAL statement_timeout = '50ms'");
  });

  it("does not record a breach for a non-timeout failure even inside a budget", async () => {
    const q = poolQuery();
    q.mockResolvedValueOnce(ok()); // SET LOCAL statement_timeout
    q.mockRejectedValueOnce(Object.assign(new Error("deadlock detected"), { code: "40P01" }));

    await runWithQueryBudget(
      { budgetMs: 50, totalSqlTimeMs: 0, route: "/api/v1/checkout", breached: false },
      async () => {
        await expect(query("SELECT 1")).rejects.toThrow("deadlock detected");
      },
    );

    expect(recordBudgetBreach).not.toHaveBeenCalled();
  });

  it("skips SET LOCAL once the budget has already been breached", async () => {
    const q = poolQuery().mockResolvedValueOnce(ok());
    const ctx = { budgetMs: 50, totalSqlTimeMs: 999, route: "/api/v1/checkout", breached: true };

    await runWithQueryBudget(ctx, () => query("SELECT 1"));

    expect(q).toHaveBeenCalledTimes(1);
    expect(q).toHaveBeenCalledWith("SELECT 1", undefined);
  });
});
