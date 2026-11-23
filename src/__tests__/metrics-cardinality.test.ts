import express from "express";
import request from "supertest";
import {
  _resetMetricCardinalityState,
  createBudgetedCounter,
  createBudgetedHistogram,
  metricsMiddleware,
  register,
} from "../metrics.js";
import {
  getSlotMetricsSnapshot,
  recordCacheStatus,
  resetSlotMetrics,
} from "../metrics/slotMetrics.js";

let sequence = 0;

function metricName(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}_total`;
}

async function metricsText(): Promise<string> {
  return register.metrics();
}

describe("metric cardinality budgets", () => {
  beforeEach(() => {
    register.resetMetrics();
    _resetMetricCardinalityState();
    resetSlotMetrics();
  });

  it("relabels new label tuples to __overflow__ after the budget is exhausted", async () => {
    const name = metricName("cardinality_budget_counter");
    const counter = createBudgetedCounter({
      name,
      help: "Test counter with a small label tuple budget",
      labels: ["route"],
      budget: 2,
    });

    counter.labels("/health").inc();
    counter.labels("/api/v1/slots").inc();
    counter.labels("/api/v1/users/attacker-controlled-id").inc();
    counter.labels("/health").inc();

    const output = await metricsText();
    expect(output).toContain(`${name}{route="/health"} 2`);
    expect(output).toContain(`${name}{route="/api/v1/slots"} 1`);
    expect(output).toContain(`${name}{route="__overflow__"} 1`);
    expect(output).not.toContain("attacker-controlled-id");
    expect(output).toContain(
      `metric_cardinality_overflow_total{metric="${name}"} 1`,
    );
  });

  it("supports object labels and keeps the accepted tuple set stable", async () => {
    const name = metricName("cardinality_budget_object_counter");
    const counter = createBudgetedCounter({
      name,
      help: "Test counter using object label input",
      labels: ["method", "route"],
      budget: 1,
    });

    counter.labels({ method: "GET", route: "/health" }).inc();
    counter.labels({ method: "POST", route: "/api/v1/high-cardinality" }).inc();
    counter.labels({ method: "GET", route: "/health" }).inc();

    const output = await metricsText();
    expect(output).toContain(`${name}{method="GET",route="/health"} 2`);
    expect(output).toContain(`${name}{method="__overflow__",route="__overflow__"} 1`);
    expect(output).not.toContain("high-cardinality");
  });

  it("treats budget 0 as no-label aggregation", async () => {
    const name = metricName("cardinality_zero_budget_counter");
    const counter = createBudgetedCounter({
      name,
      help: "Test counter that intentionally aggregates without labels",
      labels: ["tenant"],
      budget: 0,
    });

    counter.labels("tenant-a").inc();
    counter.labels("tenant-b").inc();

    const output = await metricsText();
    expect(output).toContain(`${name} 2`);
    expect(output).not.toContain("tenant-a");
    expect(output).not.toContain("tenant-b");
    expect(output).not.toContain(`metric_cardinality_overflow_total{metric="${name}"}`);
  });

  it("applies budgets to histograms as well as counters", async () => {
    const name = metricName("cardinality_budget_histogram").replace(/_total$/, "");
    const histogram = createBudgetedHistogram({
      name,
      help: "Test histogram with a small label tuple budget",
      labels: ["route"],
      budget: 1,
      buckets: [1, 5],
    });

    histogram.labels("/stable").observe(0.5);
    histogram.labels("/users/raw-user-id").observe(2);

    const output = await metricsText();
    expect(output).toMatch(
      new RegExp(`${name}_bucket\\{(?=[^}]*route="/stable")(?=[^}]*le="1")[^}]*\\} 1`),
    );
    expect(output).toMatch(
      new RegExp(`${name}_bucket\\{(?=[^}]*route="__overflow__")(?=[^}]*le="5")[^}]*\\} 1`),
    );
    expect(output).not.toContain("raw-user-id");
    expect(output).toContain(
      `metric_cardinality_overflow_total{metric="${name}"} 1`,
    );
  });

  it("relabels unexpected slot metric runtime values into overflow buckets", () => {
    recordCacheStatus("hit");
    recordCacheStatus("miss");
    recordCacheStatus("bypass");
    recordCacheStatus("tenant-controlled-cache-status" as never);

    const snapshot = getSlotMetricsSnapshot();
    expect(snapshot.cacheCounts.hit).toBe(1);
    expect(snapshot.cacheCounts.miss).toBe(1);
    expect(snapshot.cacheCounts.bypass).toBe(1);
    expect(snapshot.cacheCounts.__overflow__).toBe(1);
    expect(snapshot.cardinalityOverflowCounts.slot_cache_status).toBe(1);
  });

  it("does not expose raw unmatched request paths as HTTP metric labels", async () => {
    const app = express();
    app.use(metricsMiddleware);
    app.use((_req, res) => res.status(404).end());

    await request(app).get("/users/raw-attacker-id").expect(404);

    const output = await metricsText();
    expect(output).toContain('route="__unmatched__"');
    expect(output).not.toContain("raw-attacker-id");
  });
});
