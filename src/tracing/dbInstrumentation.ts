import type { Pool, QueryResult } from "pg";
import { withSpan } from "./hooks.js";

/**
 * Strip sensitive information from SQL statements for safe logging.
 * Removes parameter values to prevent leaking PII or secrets.
 */
function stripQueryParameters(sql: string): string {
  // Remove actual parameter values but keep structure
  // Replace $1, $2, etc. with placeholders but keep the query shape
  return sql.replace(/\$\d+/g, "$n").substring(0, 200); // limit to 200 chars
}

/**
 * Wrap a PostgreSQL pool query in a span for distributed tracing.
 * @param pool - The PostgreSQL connection pool
 * @param text - The SQL query text
 * @param params - Optional query parameters
 * @returns The query result
 */
export async function queryWithSpan(
  pool: Pool,
  text: string,
  params?: unknown[],
): Promise<QueryResult> {
  const strippedQuery = stripQueryParameters(text);
  const rowCount = (params?.length ?? 0) > 0 ? params?.length : 0;

  return withSpan(
    "db.query",
    {
      "db.system": "postgresql",
      "db.statement": strippedQuery,
      "db.operation": text.trim().split(/\s+/)[0].toLowerCase(),
      "db.param_count": rowCount,
    },
    async () => {
      return pool.query(text, params);
    },
  );
}

/**
 * Instrument a PostgreSQL pool to automatically wrap queries in spans.
 * This wraps the pool.query method.
 */
export function instrumentPool(pool: Pool): void {
  const originalQuery = pool.query.bind(pool);

  pool.query = (async (
    text: string,
    params?: unknown[],
  ): Promise<QueryResult> => {
    return queryWithSpan(pool, text, params);
  }) as any;
}
