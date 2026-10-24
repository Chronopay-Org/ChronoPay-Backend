/**
 * Regression coverage for the pool-factory seam in `src/db/connection.ts` (issue #1027).
 *
 * `_setPoolFactory()` is the only supported way to exercise this module without mocking the
 * CommonJS `pg` package, so `getPool()`'s guard chain around the injected factory is
 * load-bearing twice over: it decides what happens in production when pool creation fails,
 * *and* it is what every other suite in this repo relies on to install a fake pool.
 *
 * The failure / empty-result paths covered here are the ones the issue points at
 * (`connection.ts:120-141`):
 *
 *   line 123  if (!url)                  // empty-result guard
 *   line 124  throw new Error(...)       // the throw named in the issue
 *   line 131  pool = _poolFactory(url)   // the factory call — unguarded
 *   line 135  pool.on("error", ...)      // post-assignment initialisation
 *
 * The neighbouring normal paths (`getPool()` caching, `closePool()` teardown) are asserted
 * alongside them so a change cannot satisfy the failure tests by breaking the success ones.
 *
 * No production code is changed: where current behaviour is questionable it is pinned as an
 * explicit characterisation test and flagged in the pull request instead of silently fixed.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { Pool, PoolClient } from "pg";
import {
  getPool,
  closePool,
  _setPoolFactory,
  _resetPoolFactory,
} from "../../db/connection.js";
import { logger } from "../../utils/logger.js";

const FAKE_URL = "postgresql://user:pass@localhost:5432/test";

// ─── Mock pool client ─────────────────────────────────────────────────────────

const mockQueryFn = jest
  .fn<(text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>()
  .mockResolvedValue({ rows: [] });
const mockReleaseFn = jest.fn<() => void>();
const mockClient = { query: mockQueryFn, release: mockReleaseFn } as unknown as PoolClient;

// ─── Primary mock pool ────────────────────────────────────────────────────────

let mockConnectFn: jest.MockedFunction<(...args: any[]) => Promise<PoolClient>>;
let mockEndFn: jest.MockedFunction<(...args: any[]) => Promise<void>>;
let mockOnFn: jest.MockedFunction<(...args: any[]) => void>;
let mockPoolInstance: Pool;

/** Builds a second, distinguishable pool so tests can prove *which* factory was used. */
function buildDistinctPool(): { pool: Pool; on: jest.MockedFunction<(...args: any[]) => void> } {
  const on = jest.fn<any>();
  const pool = {
    connect: jest.fn<any>().mockResolvedValue(mockClient),
    end: jest.fn<any>().mockResolvedValue(undefined),
    on,
  } as unknown as Pool;
  return { pool, on };
}

/** Returns the `error` listener that `getPool()` registered on the mock pool. */
function registeredErrorHandler(): (err: Error) => void {
  const call = mockOnFn.mock.calls.find((c) => c[0] === "error");
  if (!call) throw new Error("getPool() did not register an 'error' listener");
  return call[1] as (err: Error) => void;
}

/** Captures the exact error thrown by `fn`, so identity (not just message) can be asserted. */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw, but it returned normally");
}

beforeEach(async () => {
  jest.clearAllMocks();
  await closePool();
  delete process.env.DATABASE_URL;

  mockConnectFn = jest.fn<any>().mockResolvedValue(mockClient);
  mockEndFn = jest.fn<any>().mockResolvedValue(undefined);
  mockOnFn = jest.fn<any>();

  mockPoolInstance = {
    connect: mockConnectFn,
    end: mockEndFn,
    on: mockOnFn,
  } as unknown as Pool;

  _setPoolFactory(() => mockPoolInstance);
  mockQueryFn.mockResolvedValue({ rows: [] });
  mockReleaseFn.mockReset();
});

afterEach(async () => {
  await closePool();
  delete process.env.DATABASE_URL;
  // Restore the real factory through its public API rather than re-importing `pg`.
  _resetPoolFactory();
});

// ─── _setPoolFactory() ────────────────────────────────────────────────────────

describe("_setPoolFactory()", () => {
  it("uses the most recently installed factory when called repeatedly", () => {
    const first = buildDistinctPool();
    const second = buildDistinctPool();

    _setPoolFactory(() => first.pool);
    _setPoolFactory(() => second.pool);
    process.env.DATABASE_URL = FAKE_URL;

    expect(getPool()).toBe(second.pool);
  });

  it("does not replace an already-cached pool — the caller must closePool() first", () => {
    process.env.DATABASE_URL = FAKE_URL;
    const cached = getPool();
    expect(cached).toBe(mockPoolInstance);

    const replacement = buildDistinctPool();
    _setPoolFactory(() => replacement.pool);

    // Documented contract: `_setPoolFactory` only swaps the factory, it does not
    // invalidate the singleton, so the cached pool is still returned.
    expect(getPool()).toBe(cached);
  });

  it("applies the new factory once the singleton has been drained", async () => {
    process.env.DATABASE_URL = FAKE_URL;
    getPool();

    const replacement = buildDistinctPool();
    _setPoolFactory(() => replacement.pool);
    await closePool();

    expect(getPool()).toBe(replacement.pool);
  });

  it("accepts a non-function factory without complaining, poisoning the next getPool() call", () => {
    // Characterisation: the seam performs no validation, so a bad injection is only
    // discovered later, at pool-creation time, as a TypeError.
    _setPoolFactory(undefined as unknown as (url: string) => Pool);
    process.env.DATABASE_URL = FAKE_URL;

    expect(() => getPool()).toThrow(TypeError);
  });
});

// ─── _resetPoolFactory() ──────────────────────────────────────────────────────

describe("_resetPoolFactory()", () => {
  it("restores the default pg.Pool factory so pooled connections work again", () => {
    _setPoolFactory(() => mockPoolInstance);
    process.env.DATABASE_URL = FAKE_URL;

    _resetPoolFactory();

    const pool = getPool();
    expect(pool).toBeInstanceOf(Pool);
    expect(pool).not.toBe(mockPoolInstance);
  });

  it("recovers the module after a bad factory injection", () => {
    _setPoolFactory(undefined as unknown as (url: string) => Pool);
    process.env.DATABASE_URL = FAKE_URL;
    expect(() => getPool()).toThrow(TypeError);

    _resetPoolFactory();

    expect(getPool()).toBeInstanceOf(Pool);
  });

  it("is idempotent", () => {
    _resetPoolFactory();
    _resetPoolFactory();

    process.env.DATABASE_URL = FAKE_URL;
    expect(getPool()).toBeInstanceOf(Pool);
  });

  it("does not tear down an existing singleton", async () => {
    process.env.DATABASE_URL = FAKE_URL;
    const cached = getPool();

    _resetPoolFactory();

    expect(getPool()).toBe(cached);
    expect(mockEndFn).not.toHaveBeenCalled();
  });
});

// ─── getPool(): empty-result guard ────────────────────────────────────────────

describe("getPool() DATABASE_URL guard", () => {
  it("throws a descriptive, actionable error when DATABASE_URL is unset", () => {
    expect(() => getPool()).toThrow(
      /DATABASE_URL environment variable is not set\. Set it to a PostgreSQL connection string/,
    );
  });

  it("treats an empty DATABASE_URL as unset", () => {
    process.env.DATABASE_URL = "";

    expect(() => getPool()).toThrow(/DATABASE_URL environment variable is not set/);
  });

  it("checks DATABASE_URL before invoking the injected factory", () => {
    const factoryFn = jest.fn<any>().mockReturnValue(mockPoolInstance);
    _setPoolFactory(factoryFn);

    expect(() => getPool()).toThrow(/DATABASE_URL environment variable is not set/);
    expect(factoryFn).not.toHaveBeenCalled();
    expect(mockOnFn).not.toHaveBeenCalled();
  });

  it("does not cache anything after a guard failure, so a fixed env recovers", () => {
    expect(() => getPool()).toThrow(/DATABASE_URL/);
    expect(mockOnFn).not.toHaveBeenCalled();

    process.env.DATABASE_URL = FAKE_URL;

    expect(getPool()).toBe(mockPoolInstance);
  });

  it("passes a whitespace-only URL straight through to the factory", () => {
    // Characterisation: only falsiness is checked, so a blank-but-truthy URL reaches pg
    // and fails there with a less actionable error.
    process.env.DATABASE_URL = "   ";
    const factoryFn = jest.fn<any>().mockReturnValue(mockPoolInstance);
    _setPoolFactory(factoryFn);

    expect(getPool()).toBe(mockPoolInstance);
    expect(factoryFn).toHaveBeenCalledWith("   ");
  });
});

// ─── getPool(): factory failure handling ──────────────────────────────────────

describe("getPool() factory failure handling", () => {
  it("propagates the factory's error unchanged rather than wrapping it", () => {
    const boom = new Error("ECONNREFUSED 127.0.0.1:5432");
    _setPoolFactory(
      jest.fn<any>().mockImplementation(() => {
        throw boom;
      }),
    );
    process.env.DATABASE_URL = FAKE_URL;

    expect(captureError(() => getPool())).toBe(boom);
  });

  it("leaves no half-initialised state behind when the factory throws", () => {
    _setPoolFactory(
      jest.fn<any>().mockImplementation(() => {
        throw new Error("factory exploded");
      }),
    );
    process.env.DATABASE_URL = FAKE_URL;

    expect(() => getPool()).toThrow("factory exploded");
    // Nothing was assigned and no listener was attached, so the module is still usable.
    expect(mockOnFn).not.toHaveBeenCalled();
  });

  it("recovers after a transient factory failure", () => {
    const factoryFn = jest
      .fn<any>()
      .mockImplementationOnce(() => {
        throw new Error("transient");
      })
      .mockReturnValue(mockPoolInstance);
    _setPoolFactory(factoryFn);
    process.env.DATABASE_URL = FAKE_URL;

    expect(() => getPool()).toThrow("transient");
    expect(getPool()).toBe(mockPoolInstance);
    expect(factoryFn).toHaveBeenCalledTimes(2);
  });

  it("invokes the factory exactly once and only when creating the singleton", () => {
    const factoryFn = jest.fn<any>().mockReturnValue(mockPoolInstance);
    _setPoolFactory(factoryFn);
    process.env.DATABASE_URL = FAKE_URL;

    getPool();
    getPool();
    getPool();

    expect(factoryFn).toHaveBeenCalledTimes(1);
    expect(factoryFn).toHaveBeenCalledWith(FAKE_URL);
  });

  it("caches a factory result that cannot accept listeners, disabling retries", () => {
    // Characterisation: `pool` is assigned *before* `pool.on()` is called, so a pool
    // object that throws during listener registration is cached permanently. The first
    // call throws; every later call silently returns the broken pool.
    const brokenPool = { end: jest.fn<any>() } as unknown as Pool;
    _setPoolFactory(() => brokenPool);
    process.env.DATABASE_URL = FAKE_URL;

    expect(() => getPool()).toThrow(TypeError);
    expect(getPool()).toBe(brokenPool);
  });
});

// ─── pool "error" listener ────────────────────────────────────────────────────

describe("pool error listener", () => {
  it("registers exactly one error listener per created pool", () => {
    process.env.DATABASE_URL = FAKE_URL;

    getPool();
    getPool();

    expect(mockOnFn).toHaveBeenCalledTimes(1);
    expect(mockOnFn).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("logs idle-client errors instead of letting them crash the process", () => {
    process.env.DATABASE_URL = FAKE_URL;
    getPool();

    const errorSpy = jest
      .spyOn(logger, "error")
      .mockImplementation((() => logger) as unknown as typeof logger.error);
    const idleError = new Error("Connection terminated unexpectedly");

    try {
      expect(() => registeredErrorHandler()(idleError)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith({ err: idleError }, "unexpected db pool error");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("re-registers the listener on a pool created after closePool()", async () => {
    process.env.DATABASE_URL = FAKE_URL;
    getPool();
    expect(mockOnFn).toHaveBeenCalledTimes(1);

    await closePool();
    getPool();

    expect(mockOnFn).toHaveBeenCalledTimes(2);
  });
});

// ─── closePool() failure handling ─────────────────────────────────────────────

describe("closePool() failure handling", () => {
  it("is a no-op when no pool has been created", async () => {
    await expect(closePool()).resolves.toBeUndefined();
    expect(mockEndFn).not.toHaveBeenCalled();
  });

  it("propagates an end() failure", async () => {
    process.env.DATABASE_URL = FAKE_URL;
    getPool();

    const endError = new Error("end() failed");
    mockEndFn.mockRejectedValueOnce(endError);

    await expect(closePool()).rejects.toThrow("end() failed");
  });

  it("keeps the drained-but-unended pool cached after an end() failure", async () => {
    // Characterisation: `pool = null` runs after `await pool.end()`, so a failed
    // teardown leaves a dead pool in the singleton instead of resetting it.
    const factoryFn = jest.fn<any>().mockReturnValue(mockPoolInstance);
    _setPoolFactory(factoryFn);
    process.env.DATABASE_URL = FAKE_URL;
    const cached = getPool();
    expect(factoryFn).toHaveBeenCalledTimes(1);

    mockEndFn.mockRejectedValueOnce(new Error("end() failed"));
    await expect(closePool()).rejects.toThrow();

    expect(getPool()).toBe(cached);
    // Proves the cached pool was reused rather than a new one being built.
    expect(factoryFn).toHaveBeenCalledTimes(1);
  });

  it("retries end() on a subsequent close", async () => {
    process.env.DATABASE_URL = FAKE_URL;
    getPool();

    mockEndFn.mockRejectedValueOnce(new Error("end() failed"));
    await expect(closePool()).rejects.toThrow();

    await expect(closePool()).resolves.toBeUndefined();
    expect(mockEndFn).toHaveBeenCalledTimes(2);
  });

  it("nulls the singleton on a successful close so a fresh pool can be created", async () => {
    process.env.DATABASE_URL = FAKE_URL;
    getPool();
    await closePool();

    expect(mockEndFn).toHaveBeenCalledTimes(1);

    const replacement = buildDistinctPool();
    _setPoolFactory(() => replacement.pool);

    expect(getPool()).toBe(replacement.pool);
  });
});
