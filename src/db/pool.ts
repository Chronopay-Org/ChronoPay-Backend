import { Pool, QueryResult } from "pg";

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
pool.on("error", (err) => {
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
 * 6. Query Wrapper
 */
export const query = async (text: string, params?: unknown[]): Promise<QueryResult> => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== "test" && process.env.NODE_ENV !== "production") {
      console.log(`Executed query in ${duration}ms`, { text, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    if (process.env.NODE_ENV !== "test") {
      console.error("Database query failed", {
        text,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
    throw error;
  }
};

export default pool;

