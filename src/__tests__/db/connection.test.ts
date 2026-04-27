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
} from "../../db/connection.js";

// ─── Mock pool client ─────────────────────────────────────────────────────────

const mockQueryFn = jest.fn<(text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>()
  .mockResolvedValue({ rows: [] });
const mockReleaseFn = jest.fn<() => void>();
const mockClient = { query: mockQueryFn, release: mockReleaseFn } as unknown as PoolClient;

// ─── Mock pool instance ───────────────────────────────────────────────────────

let mockConnectFn: jest.MockedFunction<() => Promise<PoolClient>>;
let mockEndFn: jest.MockedFunction<() => Promise<void>>;
let mockOnFn: jest.MockedFunction<(event: string, listener: (err: Error) => void) => void>;
let mockPoolInstance: Pool;

const FAKE_URL = "postgresql://user:pass@localhost:5432/test";

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(async () => {
  jest.clearAllMocks();

  // Tear down any existing singleton first
  await closePool();
  delete process.env.DATABASE_URL;

  // Build fresh mock pool methods
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockConnectFn = jest.fn<any>().mockResolvedValue(mockClient);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockEndFn = jest.fn<any>().mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockOnFn = jest.fn<(event: string, listener: (...args: any[]) => void) => any>();

  mockPoolInstance = {
    connect: mockConnectFn,
    end: mockEndFn,
    on: mockOnFn,
  } as unknown as Pool;

  // Inject the mock factory — returns our controlled pool instance
  _setPoolFactory((_url: string) => mockPoolInstance);

  // Restore mockQueryFn default behavior
  mockQueryFn.mockResolvedValue({ rows: [] });
  mockReleaseFn.mockReset();
});

afterEach(async () => {
  await closePool();
  delete process.env.DATABASE_URL;
  // Restore real pool factory after each test
  _setPoolFactory((url) => new Pool({ connectionString: url }));
});

// ─── getPool() ────────────────────────────────────────────────────────────────

describe("getPool()", () => {
  it("throws a descriptive error when DATABASE_URL is not set", () => {
    expect(() => getPool()).toThrow(/DATABASE_URL environment variable is not set/);
  });

  it("creates a Pool using the factory with the DATABASE_URL", () => {
    process.env.DATABASE_URL = FAKE_URL;
    const factoryFn = jest.fn<(url: string) => Pool>().mockReturnValue(mockPoolInstance);
    _setPoolFactory(factoryFn);
    getPool();
    expect(factoryFn).toHaveBeenCalledWith(FAKE_URL);
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
    _setPoolFactory((_url: string) => secondPool);
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
});
