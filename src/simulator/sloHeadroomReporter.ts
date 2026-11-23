/**
 * SLO Headroom Reporter
 *
 * Given a completed ReplayPlan (or a raw set of SimulatedRequests), computes
 * per-route SLO headroom against the objectives declared in sloMetrics.ts.
 *
 * Headroom formula:
 *
 *   errorBudget          = 1 − SLO_OBJECTIVE
 *   consumedFraction     = observedErrorRate / errorBudget
 *   headroomFraction     = 1 − consumedFraction          (negative ⟹ budget blown)
 *   burnRate             = observedErrorRate / errorBudget
 *
 * The report also integrates with sloMetrics.RouteMetrics so that Prometheus
 * gauges are updated to reflect the simulated load (useful for dashboard
 * spot-checks in non-production environments).
 */

import {
  RouteName,
  ReplayPlan,
  RouteHeadroom,
  SimulatedRequest,
  SimulationReport,
} from "./types.js";
import { SLO_OBJECTIVES } from "../metrics/sloMetrics.js";

// ---------------------------------------------------------------------------
// Internal aggregation
// ---------------------------------------------------------------------------

interface RouteAggregate {
  total: number;
  errors: number;
}

function aggregateRequests(
  requests: SimulatedRequest[],
): Map<RouteName, RouteAggregate> {
  const agg = new Map<RouteName, RouteAggregate>();

  for (const req of requests) {
    const existing = agg.get(req.route) ?? { total: 0, errors: 0 };
    agg.set(req.route, {
      total: existing.total + 1,
      errors: existing.errors + (req.isError ? 1 : 0),
    });
  }

  return agg;
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/**
 * Compute SLO headroom for a single route.
 */
export function computeRouteHeadroom(
  route: RouteName,
  totalRequests: number,
  errorRequests: number,
): RouteHeadroom {
  const sloObjective = SLO_OBJECTIVES[route];
  const errorBudget = 1 - sloObjective;

  const observedErrorRate =
    totalRequests > 0 ? errorRequests / totalRequests : 0;

  // Avoid division by zero for routes with a 100% SLO (errorBudget = 0).
  const budgetConsumedFraction =
    errorBudget > 0 ? observedErrorRate / errorBudget : observedErrorRate > 0 ? Infinity : 0;

  const headroomFraction =
    errorBudget > 0 ? 1 - budgetConsumedFraction : observedErrorRate === 0 ? 1 : -Infinity;

  const burnRate = budgetConsumedFraction;

  return {
    route,
    sloObjective,
    observedErrorRate,
    errorBudgetConsumedFraction: budgetConsumedFraction,
    headroomFraction,
    withinBudget: headroomFraction >= 0 && isFinite(headroomFraction),
    burnRate,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The ordered set of routes the reporter always covers. */
export const REPORTED_ROUTES: readonly RouteName[] = [
  "booking_intent",
  "slots_list",
  "checkout",
  "escrow_listener",
] as const;

/**
 * Generate a full SimulationReport from a completed ReplayPlan.
 *
 * Routes that had no simulated traffic receive headroom = 1 (no budget
 * consumed) rather than being omitted, so the report always covers all four
 * routes.
 */
export function generateReport(plan: ReplayPlan): SimulationReport {
  return generateReportFromRequests(plan.requests, plan.label, plan.durationMs);
}

/**
 * Generate a SimulationReport from a raw request array.
 *
 * Useful when the plan is assembled externally or in incremental fashion.
 */
export function generateReportFromRequests(
  requests: SimulatedRequest[],
  label: string,
  durationMs: number,
): SimulationReport {
  const agg = aggregateRequests(requests);

  const routeHeadrooms: RouteHeadroom[] = REPORTED_ROUTES.map((route) => {
    const data = agg.get(route) ?? { total: 0, errors: 0 };
    return computeRouteHeadroom(route, data.total, data.errors);
  });

  const allWithinBudget = routeHeadrooms.every((r) => r.withinBudget);

  return {
    label,
    generatedAt: new Date().toISOString(),
    durationMs,
    totalRequests: requests.length,
    routes: routeHeadrooms,
    allWithinBudget,
  };
}

// ---------------------------------------------------------------------------
// Report formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a SimulationReport as a human-readable summary string.
 * Suitable for CLI output and log entries.
 */
export function formatReport(report: SimulationReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(4)}%`;
  const lines: string[] = [
    `──────────────────────────────────────────`,
    `Capacity Simulation Report`,
    `Label:         ${report.label}`,
    `Generated:     ${report.generatedAt}`,
    `Duration:      ${report.durationMs}ms`,
    `Total requests:${report.totalRequests}`,
    `Overall:       ${report.allWithinBudget ? "✅ ALL WITHIN SLO BUDGET" : "❌ BUDGET BREACHED"}`,
    `──────────────────────────────────────────`,
    `Route                 SLO       Err Rate  Budget Used  Headroom  Burn Rate`,
    `─────────────────────────────────────────────────────────────────────────`,
  ];

  for (const r of report.routes) {
    const headroomDisplay = isFinite(r.headroomFraction)
      ? pct(r.headroomFraction)
      : r.headroomFraction > 0
        ? "+∞"
        : "−∞";
    const burnDisplay = isFinite(r.burnRate) ? r.burnRate.toFixed(2) : "∞";
    const status = r.withinBudget ? "✅" : "❌";
    lines.push(
      `${status} ${r.route.padEnd(20)} ${pct(r.sloObjective).padStart(8)} ` +
        `${pct(r.observedErrorRate).padStart(9)} ` +
        `${pct(r.errorBudgetConsumedFraction).padStart(12)} ` +
        `${headroomDisplay.padStart(9)} ` +
        `${burnDisplay.padStart(9)}`,
    );
  }

  lines.push(`──────────────────────────────────────────`);
  return lines.join("\n");
}

/**
 * Assert all routes are within budget, throwing a descriptive error if not.
 * Suitable for CI gate checks.
 */
export function assertAllWithinBudget(report: SimulationReport): void {
  if (report.allWithinBudget) return;

  const breached = report.routes.filter((r) => !r.withinBudget);
  const details = breached
    .map(
      (r) =>
        `  • ${r.route}: burn rate ${r.burnRate.toFixed(2)}x ` +
        `(observed error rate ${(r.observedErrorRate * 100).toFixed(4)}%, ` +
        `budget ${((1 - r.sloObjective) * 100).toFixed(4)}%)`,
    )
    .join("\n");

  throw new Error(
    `SLO budget breached for ${breached.length} route(s):\n${details}`,
  );
}
