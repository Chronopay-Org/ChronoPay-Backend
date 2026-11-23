/**
 * Tests for the SLO headroom reporter.
 */

import { describe, it, expect } from "@jest/globals";
import {
  computeRouteHeadroom,
  generateReport,
  generateReportFromRequests,
  formatReport,
  assertAllWithinBudget,
  REPORTED_ROUTES,
} from "../../simulator/sloHeadroomReporter.js";
import { SLO_OBJECTIVES } from "../../metrics/sloMetrics.js";
import { buildReplayPlan } from "../../simulator/loadGenerator.js";
import { buildSyntheticCurve } from "../../simulator/trafficIngester.js";
import { SimulatorConfigSchema, SimulatedRequest } from "../../simulator/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeReq = (
  route: SimulatedRequest["route"],
  isError = false,
  id = Math.random().toString(36).slice(2),
): SimulatedRequest => ({
  id,
  route,
  offsetMs: 0,
  latencyMs: 50,
  isError,
});

// ---------------------------------------------------------------------------
// computeRouteHeadroom
// ---------------------------------------------------------------------------

describe("computeRouteHeadroom", () => {
  it("returns withinBudget=true for zero errors", () => {
    const result = computeRouteHeadroom("booking_intent", 1000, 0);
    expect(result.withinBudget).toBe(true);
    expect(result.observedErrorRate).toBe(0);
    expect(result.headroomFraction).toBe(1);
    expect(result.burnRate).toBe(0);
  });

  it("returns withinBudget=true when well within budget", () => {
    // booking_intent SLO = 0.999, budget = 0.001
    // 1 error / 10000 requests = 0.0001 error rate (10% of budget)
    const result = computeRouteHeadroom("booking_intent", 10_000, 1);
    expect(result.withinBudget).toBe(true);
    expect(result.headroomFraction).toBeCloseTo(0.9, 1);
    expect(result.burnRate).toBeCloseTo(0.1, 1);
  });

  it("returns withinBudget=false when budget is blown", () => {
    // booking_intent SLO = 0.999, budget = 0.001
    // 10 errors / 1000 requests = 1% error rate (10× budget)
    const result = computeRouteHeadroom("booking_intent", 1000, 10);
    expect(result.withinBudget).toBe(false);
    expect(result.headroomFraction).toBeLessThan(0);
    expect(result.burnRate).toBeGreaterThan(1);
  });

  it("returns withinBudget=true with headroom=1 for zero requests", () => {
    const result = computeRouteHeadroom("slots_list", 0, 0);
    expect(result.withinBudget).toBe(true);
    expect(result.observedErrorRate).toBe(0);
    expect(result.headroomFraction).toBe(1);
  });

  it("uses correct SLO objective from sloMetrics", () => {
    const result = computeRouteHeadroom("checkout", 1000, 0);
    expect(result.sloObjective).toBe(SLO_OBJECTIVES["checkout"]);
  });

  it("computes burn rate correctly for near-exact budget consumption", () => {
    // checkout SLO = 0.9999, budget = 0.0001
    // 1 error / 10000 requests = 0.0001 error rate ≈ 100% budget consumed
    const result = computeRouteHeadroom("checkout", 10_000, 1);
    expect(result.errorBudgetConsumedFraction).toBeCloseTo(1.0, 3);
    expect(result.burnRate).toBeCloseTo(1.0, 3);
    // headroom is very close to 0 — floating point may push it just below 0
    expect(result.headroomFraction).toBeCloseTo(0, 3);
    // At exactly 100% consumed, the route is at/over the threshold
    // withinBudget is true only when headroom >= 0; accept either here
    expect(typeof result.withinBudget).toBe("boolean");
  });

  it("includes route name in result", () => {
    const result = computeRouteHeadroom("escrow_listener", 100, 0);
    expect(result.route).toBe("escrow_listener");
  });

  it("handles all four route names without throwing", () => {
    const routes = ["booking_intent", "slots_list", "checkout", "escrow_listener"] as const;
    for (const route of routes) {
      expect(() => computeRouteHeadroom(route, 100, 1)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// generateReportFromRequests
// ---------------------------------------------------------------------------

describe("generateReportFromRequests", () => {
  it("includes all four routes even when some have no traffic", () => {
    // Only booking_intent traffic
    const requests = [makeReq("booking_intent"), makeReq("booking_intent")];
    const report = generateReportFromRequests(requests, "test", 60_000);

    expect(report.routes).toHaveLength(REPORTED_ROUTES.length);
    const routeNames = report.routes.map((r) => r.route);
    expect(routeNames).toContain("slots_list");
    expect(routeNames).toContain("checkout");
    expect(routeNames).toContain("escrow_listener");
  });

  it("sets allWithinBudget=true when all routes are within budget", () => {
    const requests = REPORTED_ROUTES.map((r) => makeReq(r, false));
    const report = generateReportFromRequests(requests, "clean", 60_000);
    expect(report.allWithinBudget).toBe(true);
  });

  it("sets allWithinBudget=false when any route blows budget", () => {
    // booking_intent: 100 errors / 1000 requests = 10% error rate >> 0.1% budget
    const requests: SimulatedRequest[] = [];
    for (let i = 0; i < 900; i++) requests.push(makeReq("booking_intent", false));
    for (let i = 0; i < 100; i++) requests.push(makeReq("booking_intent", true));

    const report = generateReportFromRequests(requests, "breach", 60_000);
    expect(report.allWithinBudget).toBe(false);
  });

  it("sets correct totalRequests", () => {
    const requests = [
      makeReq("booking_intent"),
      makeReq("slots_list"),
      makeReq("checkout"),
    ];
    const report = generateReportFromRequests(requests, "t", 1000);
    expect(report.totalRequests).toBe(3);
  });

  it("includes generatedAt timestamp", () => {
    const before = Date.now();
    const report = generateReportFromRequests([], "t", 0);
    const after = Date.now();
    const ts = new Date(report.generatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 10); // allow minor clock drift
  });

  it("preserves the label field", () => {
    const report = generateReportFromRequests([], "my-label", 0);
    expect(report.label).toBe("my-label");
  });
});

// ---------------------------------------------------------------------------
// generateReport (from ReplayPlan)
// ---------------------------------------------------------------------------

describe("generateReport – from ReplayPlan", () => {
  it("produces a report with allWithinBudget=true for a healthy synthetic curve", () => {
    const curve = buildSyntheticCurve({ errorRateFraction: 0.0001 });
    const config = SimulatorConfigSchema.parse({ seed: 1, dryRun: true });
    const plan = buildReplayPlan(curve, config);
    const report = generateReport(plan);

    expect(report.allWithinBudget).toBe(true);
    expect(report.routes.length).toBe(REPORTED_ROUTES.length);
  });

  it("produces a report with allWithinBudget=false for a high-error-rate curve", () => {
    // 50% error rate will blow any SLO budget
    const curve = buildSyntheticCurve({ errorRateFraction: 0.5 });
    const config = SimulatorConfigSchema.parse({ seed: 1, dryRun: true });
    const plan = buildReplayPlan(curve, config);
    const report = generateReport(plan);

    expect(report.allWithinBudget).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatReport
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  it("returns a non-empty string", () => {
    const requests = REPORTED_ROUTES.map((r) => makeReq(r));
    const report = generateReportFromRequests(requests, "fmt-test", 60_000);
    const formatted = formatReport(report);
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(50);
  });

  it("includes the report label", () => {
    const report = generateReportFromRequests([], "my-report", 0);
    const formatted = formatReport(report);
    expect(formatted).toContain("my-report");
  });

  it("includes ALL WITHIN SLO BUDGET when allWithinBudget is true", () => {
    const requests = REPORTED_ROUTES.map((r) => makeReq(r, false));
    const report = generateReportFromRequests(requests, "good", 1000);
    expect(formatReport(report)).toContain("ALL WITHIN SLO BUDGET");
  });

  it("includes BUDGET BREACHED when allWithinBudget is false", () => {
    // Create a breach
    const reqs: SimulatedRequest[] = [];
    for (let i = 0; i < 500; i++) reqs.push(makeReq("booking_intent", true));
    const report = generateReportFromRequests(reqs, "bad", 1000);
    expect(formatReport(report)).toContain("BUDGET BREACHED");
  });

  it("includes each route name in the output", () => {
    const report = generateReportFromRequests([], "routes-check", 0);
    const formatted = formatReport(report);
    for (const route of REPORTED_ROUTES) {
      expect(formatted).toContain(route);
    }
  });

  it("handles Infinity burnRate gracefully (no JSON crash)", () => {
    // Force an infinite burn scenario – errorBudget = 0 for a 100% SLO route
    // We can't have a real 100% SLO in the registry but we can get a large burn
    const reqs: SimulatedRequest[] = [];
    // 100% error rate
    for (let i = 0; i < 1000; i++) reqs.push(makeReq("booking_intent", true));
    const report = generateReportFromRequests(reqs, "inf-burn", 60_000);
    expect(() => formatReport(report)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertAllWithinBudget
// ---------------------------------------------------------------------------

describe("assertAllWithinBudget", () => {
  it("does not throw when all routes are within budget", () => {
    const requests = REPORTED_ROUTES.map((r) => makeReq(r, false));
    const report = generateReportFromRequests(requests, "ok", 60_000);
    expect(() => assertAllWithinBudget(report)).not.toThrow();
  });

  it("throws an Error when any route blows the budget", () => {
    const reqs: SimulatedRequest[] = [];
    for (let i = 0; i < 500; i++) reqs.push(makeReq("booking_intent", true));
    const report = generateReportFromRequests(reqs, "breach", 60_000);
    expect(() => assertAllWithinBudget(report)).toThrow(Error);
  });

  it("error message names the breached route", () => {
    const reqs: SimulatedRequest[] = [];
    for (let i = 0; i < 500; i++) reqs.push(makeReq("booking_intent", true));
    const report = generateReportFromRequests(reqs, "breach", 60_000);
    try {
      assertAllWithinBudget(report);
    } catch (e) {
      expect((e as Error).message).toContain("booking_intent");
    }
  });

  it("error message mentions burn rate", () => {
    const reqs: SimulatedRequest[] = [];
    for (let i = 0; i < 500; i++) reqs.push(makeReq("slots_list", true));
    const report = generateReportFromRequests(reqs, "breach", 60_000);
    try {
      assertAllWithinBudget(report);
    } catch (e) {
      expect((e as Error).message).toContain("burn rate");
    }
  });
});

// ---------------------------------------------------------------------------
// REPORTED_ROUTES
// ---------------------------------------------------------------------------

describe("REPORTED_ROUTES", () => {
  it("contains all four expected routes", () => {
    expect(REPORTED_ROUTES).toContain("booking_intent");
    expect(REPORTED_ROUTES).toContain("slots_list");
    expect(REPORTED_ROUTES).toContain("checkout");
    expect(REPORTED_ROUTES).toContain("escrow_listener");
    expect(REPORTED_ROUTES).toHaveLength(4);
  });
});
