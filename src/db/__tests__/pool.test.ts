import { jest, describe, it, expect, beforeAll, afterEach } from "@jest/globals";
import type { Pool, PoolClient, QueryResult } from "pg";

type RunWithQueryBudget = <T>(
  context: { budgetMs: number; totalSqlTimeMs: number; route: string; breached: boolean },
  fn: () => T,
) => T;

let pool: Pool;
let query: (text: string, params?: unknown[]) => Promise<QueryResult>;
let runWithQueryBudget: RunWithQueryBudget;
let recordBudgetBreach: jest.Mock;

jest.unstable_mockModule("../connection.js", () => ({
  _recordBudgetBreach: jest.fn(),
  isStatementTimeoutError: (error: unknown) =>
    error instanceof Error && (error as { code?: string }).code === "57014",
}));

beforeAll(async () => {
  const poolModule = await import("../pool.js");
  const budgetModule = await import("../queryBudgetContext.js");
  const connectionModule = await import("../connection.js");

  pool = poolModule.default;
  query = poolModule.query;
  runWithQueryBudget = budgetModule.runWithQueryBudget as RunWithQueryBudget;
  recordBudgetBreach = connectionModule._recordBudgetBreach as unknown as jest.Mock;
});

function ok(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}

function mockClient() {
  return {
    query: jest.fn(async (_text: string, _params?: unknown[]) => ok()),
    release: jest.fn(),
  } as unknown as PoolClient;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("query() with a per-request budget", () => {
  it("runs BEGIN, SET LOCAL, the statement, and COMMIT on one client, then releases it", async () => {
    const client = mockClient();
    const connect = jest.spyOn(pool, "connect").mockResolvedValue(client);
    const clientQuery = jest.spyOn(client, "query");
    clientQuery
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok([{ id: 7 }]))
      .mockResolvedValueOnce(ok());
    const poolQuery = jest.spyOn(pool, "query");

    const result = await runWithQueryBudget(
      { budgetMs: 80, totalSqlTimeMs: 0, route: "/api/v1/items", breached: false },
      () => query("SELECT $1 AS id", [7]),
    );

    expect(result.rows).toEqual([{ id: 7 }]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = '80ms'",
      "SELECT $1 AS id",
      "COMMIT",
    ]);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases the client when the statement fails", async () => {
    const client = mockClient();
    jest.spyOn(pool, "connect").mockResolvedValue(client);
    const clientQuery = jest.spyOn(client, "query");
    const failure = new Error("database unavailable");
    clientQuery
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(ok());

    await expect(
      runWithQueryBudget(
        { budgetMs: 80, totalSqlTimeMs: 0, route: "/api/v1/items", breached: false },
        () => query("SELECT 1"),
      ),
    ).rejects.toBe(failure);

    expect(clientQuery.mock.calls.map(([statement]) => statement)).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = '80ms'",
      "SELECT 1",
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("maps PostgreSQL statement timeout errors to QueryBudgetExceededError", async () => {
    const client = mockClient();
    jest.spyOn(pool, "connect").mockResolvedValue(client);
    const clientQuery = jest.spyOn(client, "query");
    clientQuery
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(Object.assign(new Error("statement timeout"), { code: "57014" }))
      .mockResolvedValueOnce(ok());

    await expect(
      runWithQueryBudget(
        { budgetMs: 80, totalSqlTimeMs: 0, route: "/api/v1/items", breached: false },
        () => query("SELECT pg_sleep(1)"),
      ),
    ).rejects.toThrow("Query budget exceeded");

    expect(recordBudgetBreach).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-positive or non-integer budget before acquiring a client", async () => {
    const connect = jest.spyOn(pool, "connect");

    await expect(
      runWithQueryBudget(
        { budgetMs: 1.5, totalSqlTimeMs: 0, route: "/api/v1/items", breached: false },
        () => query("SELECT 1"),
      ),
    ).rejects.toThrow("Query budget must be a positive integer");

    expect(connect).not.toHaveBeenCalled();
  });
});
