// @ts-nocheck
import { Pool, PoolClient, PoolConfig } from "pg";
import { logger } from "../utils/logger.js";
import { slowQueryCounter, slowQueryDuration, queryBudgetBreaches } from "../metrics.js";
import { getQueryBudgetContext } from "./queryBudgetContext.js";

/**
 * Module-level singleton pool. Lazily initialized on first call to getPool().
 * Nulled by closePool() to allow re-creation (important for graceful restarts
 * and test isolation).
 */
let pool: Pool | null = null;

/**
 * Replaceable pool factory. Defaults to creating a real pg.Pool.
 * Tests inject a mock factory via _setPoolFactorx() to avoid needing to
 * mock the `pg` module (which is a CommonJS module and harder to mock in ESM).
 *
 * @internal
 */
const defaultPoolFactory: (connectionString: string, config?: PoolConfig) => Pool =
  (connectionString, config) => new Pool({ connectionString, ...config });
let _poolFactory: (connectionString: string, config?: PoolConfig) => Pool = defaultPoolFactory;

/**
 * Replaces the pool factory used by getPool(). For testing only.
 * Always call closePool() before and after to reset the singleton.
 *
 * @internal
 */
export function _setPoolFactory(factory: (connectionString: string, config?: PoolConfig) => Pool): void {
  _poolFactory = factory;
}

/** @internal — restores the default pg.Pool factory after tests. */
export function _resetPoolFactory(): void {
  _poolFactory = defaultPoolFactory;
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

/** PostgreSQL error code returned when statement_timeout cancels a query. */
const PG_STATEMENT_TIMEOUT_CODE = "57014";

/**
 * Record a budget breach at the connection layer.
 * Called by any query wrapper when a PostgreSQL query_canceled (57014) error
 * is detected while a QueryBudgetContext is active.
 *
 * Idempotent — only records the first breach per request.
 *
 * @internal
 */
export function _recordBudgetBreach(queryText: string, budgetMs: number, route: string): void {
  queryBudgetBreaches.labels(route).inc();
  logger.warn(
    {
      query: queryText,
      budgetMs,
      route,
    },
    "query budget breached — statement_timeout cancelled query",
  );
}

/**
 * Detect whether an error is a PostgreSQL statement_timeout cancellation.
 */
export function isStatementTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === PG_STATEMENT_TIMEOUT_CODE
  );
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
 * Resolve the connection URL from the environment.
 *
 * DATABASE_URL is the canonical variable. POSTGRESQL_URL is accepted as a
 * deprecated alias and logs a warning when used.
 */
function resolveConnectionUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    return databaseUrl;
  }

  const legacyUrl = process.env.POSTGRESQL_URL;
  if (legacyUrl) {
    logger.warn(
      "POSTGRESQL_URL is deprecated; use DATABASE_URL instead.",
    );
    return legacyUrl;
  }

  throw new Error(
    "Database connection URL is not set. " +
      "Set DATABASE_URL to a PostgreSQL connection string, e.g. " +
      "postgresql://user:password@localhost:5432/chronopay",
  );
}

/**
 * Resolve the configurable pool size from DB_POOL_MAX.
 * Defaults to 10 (pg default) when unset or invalid.
 */
function resolvePoolMax(): number | undefined {
  const raw = process.env.DB_POOL_MAX;
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn({ value: raw }, "invalid DB_POOL_MAX, ignoring");
    return undefined;
  }
  return Math.floor(parsed);
}

/**
 * Returns the shared pg.Pool, creating it on first call.
 *
 * Reads DATABASE_URL (or the deprecated POSTGRESQL_URL alias) from the
 * environment. Throws a descriptive error if the variable is absent rather
 * than letting pg fail silently with a cryptic message.
 */
export function getPool(): Pool {
  if (!pool) {
    const url = resolveConnectionUrl();
    const max = resolvePoolMax();

    pool = _poolFactory(url, max !== undefined ? { max } : undefined);

    // Surface idle-client background errors to stderr instead of crashing
    // the process or swallowing them silently.
    pool.on("error", (err: Error) => {
      logger.error({ err }, "unexpected db pool error");
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
 * Executes `fn` inside a database transaction with per-request statement_timeout.
 *
 * When an active QueryBudgetContext exists (set by the query-budget middleware),
 * the transaction client runs `SET LOCAL statement_timeout` after BEGIN so that
 * all statements within the transaction respect the budget.
 *
 * Acquires a client from the pool, issues BEGIN, and invokes `fn`. On success,
 * COMMIT is issued and the result is returned. On any error thrown by `fn`,
 * ROLLBACK is attempted (failure to roll back is logged but does not mask
 * the original error), the client is released, and the original error is re-thrown.
 *
 * The client is always released in a finally block regardless of outcome.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const ctx = getQueryBudgetContext();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Set statement_timeout for the transaction if a budget is active
    if (ctx && !ctx.breached) {
      await client.query(
        `SET LOCAL statement_timeout = '${ctx.budgetMs}ms'`,
      );
    }

    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (originalErr) {
    // Detect budget breach
    if (ctx && !ctx.breached && isStatementTimeoutError(originalErr)) {
      ctx.breached = true;
      _recordBudgetBreach("(transaction)", ctx.budgetMs, ctx.route);
    }
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // Log but do not mask — the caller needs to see the original failure.
      logger.error({ err: rollbackErr }, "db ROLLBACK failed");
    }
    throw originalErr;
  } finally {
    client.release();
  }
}
