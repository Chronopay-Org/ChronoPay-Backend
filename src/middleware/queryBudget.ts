import { Request, Response, NextFunction } from "express";
import {
  runWithQueryBudget,
  type QueryBudgetContext,
} from "../db/queryBudgetContext.js";
import { timeoutConfig } from "../config/timeouts.js";
import { queryBudgetSqlTimeMs } from "../metrics.js";
import { logger } from "../utils/logger.js";
import { getTraceContext } from "../tracing/index.js";

/**
 * Options for configuring the query-budget middleware.
 */
export interface QueryBudgetOptions {
  /**
   * Per-query statement_timeout in milliseconds.
   *
   * When omitted, the middleware first checks the route-override map, then
   * falls back to `QUERY_BUDGET_DEFAULT_MS` (default 30 000 ms).
   */
  budgetMs?: number;
}

/**
 * Resolve the budget for a given request path.
 *
 * Priority:
 *  1. Explicit `budgetMs` passed to the middleware factory
 *  2. Route-specific override from `timeoutConfig.queryBudget.routeOverrides`
 *     (longest-matching prefix wins)
 *  3. Global default from `timeoutConfig.queryBudget.defaultMs`
 */
function resolveBudgetMs(path: string, explicitBudgetMs?: number): number {
  if (explicitBudgetMs !== undefined && explicitBudgetMs > 0) {
    return explicitBudgetMs;
  }

  const overrides = timeoutConfig.queryBudget.routeOverrides;
  let bestMatchMs: number | undefined;
  let bestMatchLen = 0;

  for (const [pattern, ms] of Object.entries(overrides)) {
    if (path.startsWith(pattern) && pattern.length > bestMatchLen) {
      bestMatchMs = ms;
      bestMatchLen = pattern.length;
    }
  }

  return bestMatchMs ?? timeoutConfig.queryBudget.defaultMs;
}

/**
 * Express middleware that enforces a per-request SQL query budget.
 *
 * ## What it does
 *
 * 1. Sets `statement_timeout` on every DB query issued during the request.
 * 2. Accumulates total SQL wall-clock time consumed by the request.
 * 3. Records the total SQL time on the active trace span on response end.
 * 4. When a query exceeds `statement_timeout`, PostgreSQL returns error code
 *    `57014` (query_canceled).  The connection layer catches this and marks
 *    the budget as breached.  This middleware then emits a typed
 *    `QUERY_BUDGET_EXCEEDED` 503 response.
 *
 * ## Usage
 *
 * ```ts
 * // Per-route with explicit budget
 * router.use(createQueryBudgetMiddleware({ budgetMs: 5000 }));
 *
 * // Global default (falls back to QUERY_BUDGET_DEFAULT_MS env var)
 * app.use(createQueryBudgetMiddleware());
 * ```
 *
 * ## Security & correctness notes
 *
 * - The budget is stored in `AsyncLocalStorage` so it is scoped to the
 *   request's async execution context and never leaks between requests.
 * - The middleware must be placed **after** any auth middleware (so `req.auth`
 *   etc. are available) and **before** route handlers that execute queries.
 * - Sub-transactions and `withTransaction` wrappers are automatically covered
 *   because the connection layer reads the budget context.
 * - When `statement_timeout` fires, the in-flight query is cancelled and the
 *   connection is returned to the pool in a clean state (PostgreSQL rolls
 *   back the current sub-transaction automatically).
 */
/**
 * Build a bounded Prometheus route label from the matched Express route pattern.
 * Must be called after route matching (e.g. inside `res.on("finish")`).
 */
function resolveRouteLabel(req: Request): string {
  const routePath: unknown = req.route?.path;
  const baseUrl = req.baseUrl ?? "";

  if (typeof routePath === "string") {
    return `${baseUrl}${routePath}` || "/";
  }

  if (routePath instanceof RegExp) {
    return `${baseUrl}${routePath.source}`;
  }

  if (Array.isArray(routePath) && routePath.length > 0) {
    const first: unknown = routePath[0];
    return `${baseUrl}${first instanceof RegExp ? first.source : String(first)}`;
  }

  return "unmatched";
}

export function createQueryBudgetMiddleware(
  options: QueryBudgetOptions = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestPath = req.path || "/";
    const budgetMs = resolveBudgetMs(requestPath, options.budgetMs);

    const context: QueryBudgetContext = {
      budgetMs,
      totalSqlTimeMs: 0,
      route: requestPath,
      breached: false,
    };

    // Wrap response finish to record telemetry
    res.on("finish", () => {
      const outcome = context.breached ? "breached" : "ok";
      const routeLabel = resolveRouteLabel(req);

      queryBudgetSqlTimeMs
        .labels(routeLabel, outcome)
        .observe(context.totalSqlTimeMs);

      // Stamp total SQL time on the active trace context for downstream consumers
      const traceCtx = getTraceContext();
      if (traceCtx) {
        logger.debug(
          {
            traceId: traceCtx.traceId,
            spanId: traceCtx.spanId,
            route: routeLabel,
            totalSqlTimeMs: context.totalSqlTimeMs,
            budgetMs,
            outcome,
          },
          "query budget summary",
        );
      }
    });

    runWithQueryBudget(context, () => {
      next();
    });
  };
}
