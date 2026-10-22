import { Pool, PoolClient, QueryResult } from "pg";
import { getQueryBudgetContext } from "./queryBudgetContext.js";
import { _recordBudgetBreach, isStatementTimeoutError } from "./connection.js";
import { QueryBudgetExceededError } from "../errors/AppError.js";

/**
 * 1. Configuration & POSTGRESQL_URL
 * We extract POSTGRESQL_URL from the environment.
 * If it is missing, we throw an error to fail fast.
 */
if (!process.env.POSTGRESQL_URL) {
  throw new Error("FATAL: POSTGRESQL_URL environment variable is missing.");
}

/**
 * 2. Singleton Pool Instantiation
 * The pool instance is created exactly once when this module is required.
 */
const pool = new Pool({
  connectionString: process.env.POSTGRESQL_URL,
  max: 20, // max number of clients in the pool
  idleTimeoutMillis: 30000, // how long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 5000, 
});

/**
 * 3. Pool Error Handling
 * Handles unexpected errors on idle PostgreSQL clients.
 */
pool.on("error", (err: Error) => {
  console.error("Unexpected error on idle PostgreSQL client", err);
});

/**
 * 4. Graceful Shutdown Helper
 */
export const closePool = async (): Promise<void> => {
  if (process.env.NODE_ENV !== "test") {
    console.log("Closing PostgreSQL connection pool...");
  }
  await pool.end();
  if (process.env.NODE_ENV !== "test") {
    console.log("PostgreSQL connection pool closed.");
  }
};

/**
 * 5. Initialization Check
 * Validates the initial connection to the database. Throws on failure.
 */
export const initDB = async (): Promise<void> => {
  try {
    const res = await pool.query("SELECT 1 AS connected");
    if (res.rowCount === 1 && process.env.NODE_ENV !== "test") {
      console.log("Successfully initialized PostgreSQL connection pool.");
    }
  } catch (error) {
    throw new Error(`Database connection failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
};

/**
 * 6. Query wrapper with per-request statement_timeout budget enforcement.
 *
 * When an active QueryBudgetContext exists (set by the query-budget
 * middleware), this wrapper:
 *
 * 1. Runs `SET LOCAL statement_timeout = '<budget>ms'` and the actual query
 *    on the same client inside a transaction so PostgreSQL cancels any
 *    statement that exceeds the budget.
 * 2. Accumulates wall-clock SQL time into the budget context.
 * 3. Detects PostgreSQL error code `57014` (query_canceled) and marks the
 *    budget as breached.
 *
 * When no budget context is active (e.g. background jobs, health checks),
 * this behaves identically to the original `pool.query`.
 */
export const query = async (text: string, params?: unknown[]): Promise<QueryResult> => {
  const ctx = getQueryBudgetContext();
  const start = Date.now();
  let client: PoolClient | undefined;
  let transactionStarted = false;
  let transactionCommitted = false;

  try {
    let res: QueryResult;

    if (ctx && !ctx.breached) {
      if (!Number.isInteger(ctx.budgetMs) || ctx.budgetMs <= 0) {
        throw new RangeError("Query budget must be a positive integer");
      }

      client = await pool.connect();
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query(`SET LOCAL statement_timeout = '${ctx.budgetMs}ms'`);
      res = await client.query(text, params);
      await client.query("COMMIT");
      transactionCommitted = true;
    } else {
      res = await pool.query(text, params);
    }

    const duration = Date.now() - start;

    if (process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "production") {
      console.log(`Executed query in ${duration}ms`, { text, rows: res.rowCount });
    }

    // Accumulate SQL time into the budget context
    if (ctx) {
      ctx.totalSqlTimeMs += duration;
    }

    return res;
  } catch (error) {
    const duration = Date.now() - start;

    // Accumulate failed-query time too — the server spent time on it
    if (ctx) {
      ctx.totalSqlTimeMs += duration;
    }

    // Detect budget breach — re-throw as typed error
    if (ctx && !ctx.breached && isStatementTimeoutError(error)) {
      ctx.breached = true;
      _recordBudgetBreach(text.substring(0, 200), ctx.budgetMs, ctx.route);
      throw new QueryBudgetExceededError(
        `Query budget exceeded: statement took longer than ${ctx.budgetMs}ms`,
        { budgetMs: ctx.budgetMs, route: ctx.route, query: text.substring(0, 200) },
      );
    }

    if (process.env.NODE_ENV !== "test") {
      console.error("Database query failed", {
        text,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
    throw error;
  } finally {
    if (client) {
      if (transactionStarted && !transactionCommitted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Database query rollback failed", {
            message: rollbackError instanceof Error ? rollbackError.message : "Unknown error",
          });
        }
      }
      client.release();
    }
  }
};

export default pool;

export { pool };
