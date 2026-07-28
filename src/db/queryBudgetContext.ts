import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request query budget context.
 *
 * Populated by the query-budget middleware at the start of each request.
 * The connection layer reads this context to:
 *   - Enforce `statement_timeout` on every query
 *   - Accumulate total SQL wall-clock time across all queries in the request
 *   - Detect budget breaches and emit typed errors
 */
export interface QueryBudgetContext {
  /** Per-query statement_timeout in milliseconds. */
  budgetMs: number;
  /** Accumulated SQL wall-clock time (ms) across all queries in this request. */
  totalSqlTimeMs: number;
  /** Route pattern that triggered this budget (e.g. "/api/v1/checkout"). */
  route: string;
  /** Whether the budget has been breached for this request. */
  breached: boolean;
}

const storage = new AsyncLocalStorage<QueryBudgetContext>();

/**
 * Run a function within a query-budget scope.
 * All queries executed (directly or transitively) inside `fn` will respect
 * the budget and accumulate their wall-clock time.
 */
export function runWithQueryBudget<T>(
  context: QueryBudgetContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

/**
 * Retrieve the active query-budget context, or `undefined` when no budget
 * middleware is in effect (e.g. background jobs, health checks).
 */
export function getQueryBudgetContext(): QueryBudgetContext | undefined {
  return storage.getStore();
}
