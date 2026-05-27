import { Pool, PoolClient } from "pg";
import { logger } from "../utils/logger.js";
import { slowQueryCounter, slowQueryDuration } from "../metrics.js";

/**
 * Module-level singleton pool. Lazily initialized on first call to getPool().
 * Nulled by closePool() to allow re-creation (important for graceful restarts
 * and test isolation).
 */
let pool: Pool | null = null;

/**
 * Replaceable pool factory. Defaults to creating a real pg.Pool.
 * Tests inject a mock factory via _setPoolFactory() to avoid needing to
 * mock the `pg` module (which is a CommonJS module and harder to mock in ESM).
 *
 * @internal
 */
let _poolFactory: (connectionString: string) => Pool = (connectionString) =>
  new Pool({ connectionString });

/**
 * Replaces the pool factory used by getPool(). For testing only.
 * Always call closePool() before and after to reset the singleton.
 *
 * @internal
 */
export function _setPoolFactory(factory: (connectionString: string) => Pool): void {
  _poolFactory = factory;
}

/**
 * Slow-query threshold in milliseconds. Null = disabled.
 * Defaults to SLOW_QUERY_THRESHOLD_MS env var; overridable in tests via _setSlowQueryThreshold().
 */
let _slowQueryThresholdMs: number | null = process.env.SLOW_QUERY_THRESHOLD_MS
  ? Number(process.env.SLOW_QUERY_THRESHOLD_MS)
  : null;

/** @internal — for test injection only */
export function _setSlowQueryThreshold(ms: number | null): void {
  _slowQueryThresholdMs = ms;
}

/**
 * Wraps a query execution function with slow-query detection.
 *
 * When the threshold is set and the query duration exceeds it, emits a
 * structured warn log (query text only — no params to avoid leaking PII)
 * and increments the slow-query counter and duration histogram.
 *
 * @param queryText  The SQL query string (logged as-is; never include params here).
 * @param execute    Async function that performs the actual query.
 */
export async function instrumentQuery<T>(
  queryText: string,
  execute: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await execute();
  } finally {
    const duration = Date.now() - start;
    if (_slowQueryThresholdMs !== null && duration >= _slowQueryThresholdMs) {
      logger.warn({ query: queryText, durationMs: duration, threshold: _slowQueryThresholdMs }, "slow query detected");
      slowQueryCounter.inc();
      slowQueryDuration.observe(duration);
    }
  }
}

/**
 * Returns the shared pg.Pool, creating it on first call.
 *
 * Reads DATABASE_URL from the environment. Throws a descriptive error if the
 * variable is absent rather than letting pg fail silently with a cryptic message.
 */
export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL environment variable is not set. " +
          "Set it to a PostgreSQL connection string, e.g. " +
          "postgresql://user:password@localhost:5432/chronopay",
      );
    }

    pool = _poolFactory(url);

    // Surface idle-client background errors to stderr instead of crashing
    // the process or swallowing them silently.
    pool.on("error", (err: Error) => {
      console.error("[db/connection] Unexpected pool error:", err.message);
    });
  }

  return pool;
}

/**
 * Drains the pool and nulls the singleton reference.
 * Safe to call even when no pool exists (no-op).
 * Call this during graceful shutdown or between tests to avoid handle leaks.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Executes `fn` inside a database transaction.
 *
 * Acquires a client from the pool, issues BEGIN, and invokes `fn`. On success,
 * COMMIT is issued and the result is returned. On any error thrown by `fn`,
 * ROLLBACK is attempted (failure to roll back is logged but does not mask the
 * original error), the client is released, and the original error is re-thrown.
 *
 * The client is always released in a finally block regardless of outcome.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (originalErr) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // Log but do not mask — the caller needs to see the original failure.
      console.error(
        "[db/connection] ROLLBACK failed:",
        (rollbackErr as Error).message,
      );
    }
    throw originalErr;
  } finally {
    client.release();
  }
}
