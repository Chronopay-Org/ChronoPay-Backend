/**
 * Tests for src/db/connection.ts
 *
 * Uses the _setPoolFactory() test seam to inject a mock pool factory instead
 * of mocking the `pg` module (which is a CommonJS module that cannot be
 * reliably mocked via jest.mock() in this project's ESM+experimental-vm-modules
 * setup). No jest.mock() calls needed — pure dependency injection.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { Pool, PoolClient } from "pg";
import {
  getPool,
  closePool,
  withTransaction,
  _setPoolFactory,
  _resetPoolFactory,
} from "../../db/connection.js";
import { runWithQueryBudget } from "../../db/queryBudgetContext.js";
import { logger } from "../../utils/logger.js";

// ─── Mock pool client ─────────────────────────────────────────────────────────

const mockQueryFn = jest.fn<(text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>()
  .mockResolvedValue({ rows: [] });
const mockReleaseFn = jest.fn<() => void>();
const mockClient = { query: mockQueryFn, release: mockReleaseFn } as unknown as PoolClient;

// ─── Mock pool instance ───────────────────────────────────────────────────────

let mockConnectFn: jest.MockedFunction<(...args: any[]) => Promise<PoolClient>>;
let mockEndFn: jest.MockedFunction<(...args: any[]) => Promise<void>>;
let mockOnFn: jest.MockedFunction<(...args: any[]) => void>;
let mockPoolInstance: Pool;

const FAKE_URL = "postgresql://user:pass@localhost:5432/test";

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(async () => {
  jest.clearAllMocks();

  // Tear down any existing singleton first
  await closePool();
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRESQL_URL;
  delete process.env.DB_POOL_MAX;

  // Build fresh mock pool methods
  mockConnectFn = jest.fn<any>().mockResolvedValue(mockClient);
  mockEndFn = jest.fn<any>().mockResolvedValue(undefined);
  mockOnFn = jest.fn<any>();

  mockPoolInstance = {
    connect: mockConnectFn,
    end: mockEndFn,
    on: mockOnFn,
  } as unknown as Pool;

  // Inject the mock factory — returns our controlled pool instance
  _setPoolFactory(() => mockPoolInstance);

  // Restore mockQueryFn default behavior
  mockQueryFn.mockResolvedValue({ rows: [] });
  mockReleaseFn.mockReset();
});

afterEach(async () => {
  await closePool();
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRESQL_URL;
  delete process.env.DB_POOL_MAX;
  // Restore real pool factory after each test
  _resetPoolFactory();
});

// ─── getPool() ────────────────────────────────────────────────────────────────

describe("getPool()", () => {
  it("throws a descriptive error when DATABASE_URL is not set", () => {
    expect(() => getPool()).toThrow(/Database connection URL is not set/);
  });

  it("throws a descriptive error when neither DATABASE_URL nor POSTGRESQL_URL is set", () => {
    expect(() => getPool()).toThrow(/Database connection URL is not set/);
  });

  it("creates a Pool using the factory with the DATABASE_URL", () => {
    process.env.DATABASE_URL = FAKE_URL;
    const factoryFn = jest.fn<any>().mockReturnValue(mockPoolInstance);
    _setPoolFactory(factoryFn);
    getPool();
    expect(factoryFn).toHaveBeenCalledWith(FAKE_URL, undefined);
  });

  it("falls back to POSTGRESQL_URL as a deprecated alias and logs a warning", () => {
    process.env.POSTGRESQL_URL = FAKE_URL;
    const warnSpy = jest
      .spyOn(logger, "warn")
      .mockImplementation((() => logger) as unknown as typeof logger.warn);
    const factoryFn = jest.fn<any>().mockReturnValue(mockPoolInstance);
    _setPoolFactory(factoryFn);
    getPool();
    expect(factoryFn).toHaveBeenCalledWith(FAKE_URL, undefined);
    expect(warnSpy).toHaveBeenCalledWith(
      "POSTGRESQL_URL is deprecated; use DATABASE_URL instead.",
    );
    warnSpy.mockRestore();
  });

  it("registers an error handler on the pool", () => {
    process.env.DATABASE_URL = FAKE_URL;
    getPool();
    expect(mockOnFn).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("returns the same Pool instance on subsequent calls (singleton)", () => {
    process.env.DATABASE_URL = FAKE_URL;
    const p1 = getPool();
    const p2 = getPool();
    expect(p1).toBe(p2);
    // Factory called only once (second call hits singleton cache)
    expect(mockConnectFn).not.toHaveBeenCalled(); // only to verify same object
    expect(p1).toBe(mockPoolInstance);
  });
});

// ─── closePool() ─────────────────────────────────────────────────────────────

describe("closePool()", () => {
  it("is a no-op when no pool has been created", async () => {
    await expect(closePool()).resolves.toBeUndefined();
    expect(mockEndFn).not.toHaveBeenCalled();
  });

  it("ends the pool and allows a new pool to be created", async () => {
    process.env.DATABASE_URL = FAKE_URL;
    getPool();
    await closePool();
    expect(mockEndFn).toHaveBeenCalledTimes(1);

    // Build a second mock pool to confirm re-creation
    const secondPool = { connect: jest.fn(), end: jest.fn(), on: jest.fn() } as unknown as Pool;
    _setPoolFactory(() => secondPool);
    const p2 = getPool();
    expect(p2).toBe(secondPool);
  });

  it("nulls the singleton so a second closePool call is a no-op", async () => {
    process.env.DATABASE_URL = FAKE_URL;
    getPool();
    await closePool();
    await closePool(); // second call — should not call end again
    expect(mockEndFn).toHaveBeenCalledTimes(1);
  });

  it("allows a new pool after closePool even when the factory was reset", async () => {
    process.env.DATABASE_URL = FAKE_URL;
    getPool();
    await closePool();
    _resetPoolFactory();
    expect(() => getPool()).not.toThrow();
  });
});

// ─── withTransaction() ───────────────────────────────────────────────────────

describe("withTransaction()", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = FAKE_URL;
  });

  it("issues BEGIN and COMMIT around a successful callback", async () => {
    const fn = jest.fn<(c: PoolClient) => Promise<string>>().mockResolvedValue("ok");
    await withTransaction(fn as unknown as (c: PoolClient) => Promise<string>);

    const queryCalls = mockQueryFn.mock.calls.map((c) => c[0]);
    expect(queryCalls).toContain("BEGIN");
    expect(queryCalls).toContain("COMMIT");
    expect(queryCalls).not.toContain("ROLLBACK");
  });

  it("returns the value returned by the callback", async () => {
    const fn = jest.fn<(c: PoolClient) => Promise<number>>().mockResolvedValue(42);
    const result = await withTransaction(fn as unknown as (c: PoolClient) => Promise<number>);
    expect(result).toBe(42);
  });

  it("passes the client to the callback", async () => {
    const fn = jest.fn<(c: PoolClient) => Promise<void>>().mockResolvedValue(undefined);
    await withTransaction(fn as unknown as (c: PoolClient) => Promise<void>);
    expect(fn).toHaveBeenCalledWith(mockClient);
  });

  it("issues ROLLBACK and re-throws when the callback throws", async () => {
    const boom = new Error("migration failed");
    const fn = jest.fn<(c: PoolClient) => Promise<never>>().mockRejectedValue(boom);

    await expect(
      withTransaction(fn as unknown as (c: PoolClient) => Promise<never>),
    ).rejects.toThrow("migration failed");

    const queryCalls = mockQueryFn.mock.calls.map((c) => c[0]);
    expect(queryCalls).toContain("ROLLBACK");
    expect(queryCalls).not.toContain("COMMIT");
  });

  it("always releases the client on success", async () => {
    const fn = jest.fn<(c: PoolClient) => Promise<void>>().mockResolvedValue(undefined);
    await withTransaction(fn as unknown as (c: PoolClient) => Promise<void>);
    expect(mockReleaseFn).toHaveBeenCalledTimes(1);
  });

  it("always releases the client on failure", async () => {
    const fn = jest.fn<(c: PoolClient) => Promise<never>>().mockRejectedValue(new Error("x"));
    await expect(
      withTransaction(fn as unknown as (c: PoolClient) => Promise<never>),
    ).rejects.toThrow();
    expect(mockReleaseFn).toHaveBeenCalledTimes(1);
  });

  it("re-throws the original error even when ROLLBACK also fails", async () => {
    const originalErr = new Error("original failure");
    const rollbackErr = new Error("rollback failure");
    const fn = jest.fn<(c: PoolClient) => Promise<never>>().mockRejectedValue(originalErr);

    // BEGIN succeeds, ROLLBACK fails
    mockQueryFn
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockRejectedValueOnce(rollbackErr);  // ROLLBACK

    await expect(
      withTransaction(fn as unknown as (c: PoolClient) => Promise<never>),
    ).rejects.toThrow("original failure");
  });

  it("issues a parameterized set_config inside BEGIN for a valid budget", async () => {
    const budgetMs = 1500;
    const fn = jest.fn<(c: PoolClient) => Promise<string>>().mockResolvedValue("ok");

    const result = await runWithQueryBudget(
      { budgetMs, totalSqlTimeMs: 0, route: "/api/v1/test", breached: false },
      () => withTransaction(fn as unknown as (c: PoolClient) => Promise<string>),
    );

    expect(result).toBe("ok");

    const calls = mockQueryFn.mock.calls;
    const beginIdx = calls.findIndex((c) => c[0] === "BEGIN");
    const setConfigIdx = calls.findIndex(
      (c) => c[0] === "SELECT set_config('statement_timeout', $1, true)",
    );
    const commitIdx = calls.findIndex((c) => c[0] === "COMMIT");

    expect(beginIdx).toBe(0);
    expect(setConfigIdx).toBeGreaterThan(beginIdx);
    expect(setConfigIdx).toBeLessThan(commitIdx);
    expect(calls[setConfigIdx]).toEqual([
      "SELECT set_config('statement_timeout', $1, true)",
      [String(Math.trunc(budgetMs))],
    ]);

    // The timeout must be configured after BEGIN but before the callback runs.
    const beginOrder = mockQueryFn.mock.invocationCallOrder[beginIdx];
    const setConfigOrder = mockQueryFn.mock.invocationCallOrder[setConfigIdx];
    const commitOrder = mockQueryFn.mock.invocationCallOrder[commitIdx];
    const callbackOrder = fn.mock.invocationCallOrder[0];

    expect(beginOrder).toBeLessThan(setConfigOrder);
    expect(setConfigOrder).toBeLessThan(callbackOrder);
    expect(callbackOrder).toBeLessThan(commitOrder);
  });

  it.each([
    ["NaN", Number.NaN],
    ["zero", 0],
    ["negative", -100],
    ["non-integer", 12.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("skips the timeout statement for a %s budget", async (_label, budgetMs) => {
    const fn = jest.fn<(c: PoolClient) => Promise<string>>().mockResolvedValue("ok");

    const result = await runWithQueryBudget(
      { budgetMs, totalSqlTimeMs: 0, route: "/api/v1/test", breached: false },
      () => withTransaction(fn as unknown as (c: PoolClient) => Promise<string>),
    );

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledWith(mockClient);
    expect(mockQueryFn.mock.calls).toEqual([["BEGIN"], ["COMMIT"]]);
    expect(
      mockQueryFn.mock.calls.some((c) => String(c[0]).includes("statement_timeout")),
    ).toBe(false);
  });
});
