import type { Pool, QueryResult } from "pg";
import { withSpan } from "./hooks.js";

/** Symbol used to mark an already-instrumented pool so double-wrapping is a no-op. */
const INSTRUMENTED = Symbol("chronopay.instrumented");

/**
 * Strip sensitive information from SQL statements for safe logging.
 * Replaces positional parameters ($1, $2, …) with $n and caps at 200 chars.
 */
function stripQueryParameters(sql: string): string {
  return sql.replace(/\$\d+/g, "$n").substring(0, 200);
}

/**
 * Wrap a single pool query call in a tracing span.
 *
 * @param runQuery - The bound original `pool.query` to invoke.
 * @param text     - SQL query text.
 * @param params   - Optional positional parameters.
 */
export async function queryWithSpan(
  runQuery: (text: string, params?: unknown[]) => Promise<QueryResult>,
  text: string,
  params?: unknown[],
): Promise<QueryResult> {
  const strippedQuery = stripQueryParameters(text);
  const paramCount = params?.length ?? 0;

  return withSpan(
    "db.query",
    {
      "db.system": "postgresql",
      "db.statement": strippedQuery,
      "db.operation": text.trim().split(/\s+/)[0].toLowerCase(),
      "db.param_count": paramCount,
    },
    async () => runQuery(text, params),
  );
}

/** Narrow augmentation so TypeScript knows our symbol property exists on Pool. */
interface InstrumentedPool extends Pool {
  [INSTRUMENTED]?: true;
}

/**
 * Monkey-patch `pool.query` to wrap every call in a tracing span.
 *
 * Idempotent: calling this twice on the same pool is a no-op — the second
 * call returns immediately without adding another layer of wrapping.
 */
export function instrumentPool(pool: Pool): void {
  const p = pool as InstrumentedPool;
  if (p[INSTRUMENTED]) return;

  // Capture the original before we overwrite it.
  const original = pool.query.bind(pool) as (
    text: string,
    params?: unknown[],
  ) => Promise<QueryResult>;

  pool.query = (async (
    text: string,
    params?: unknown[],
  ): Promise<QueryResult> => queryWithSpan(original, text, params)) as typeof pool.query;

  p[INSTRUMENTED] = true;
}
