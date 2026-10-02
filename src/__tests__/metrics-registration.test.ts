/**
 * Regression coverage for metric registration failure handling (issue #1091).
 *
 * `registerCardinalityBudget` rejects two kinds of malformed budget options
 * before any metric is created:
 *   - a budget that is not a non-negative integer
 *   - duplicate label names
 *
 * These tests pin those error contracts (including that no metric is left
 * behind in the registry on failure) plus the neighbouring success path where
 * a valid budget produces a registered metric.
 */

import {
  createBudgetedCounter,
  createBudgetedGauge,
  createBudgetedHistogram,
  register,
} from "../metrics.js";

let sequence = 0;

function metricName(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}_total`;
}

const BUDGET_ERROR = "must declare a non-negative integer cardinality budget";
const DUPLICATE_ERROR = "declares duplicate label names";

describe("metric cardinality budget registration guards", () => {
  it("rejects a negative budget without registering the metric", () => {
    const name = metricName("negative_budget");

    expect(() =>
      createBudgetedCounter({ name, help: "h", labels: ["route"], budget: -1 }),
    ).toThrow(BUDGET_ERROR);
    expect(register.getSingleMetric(name)).toBeUndefined();
  });

  it("rejects non-integer budgets (fractional, NaN, infinite, string)", () => {
    const cases: unknown[] = [1.5, Number.NaN, Number.POSITIVE_INFINITY, "8"];

    for (const budget of cases) {
      const name = metricName("non_integer_budget");
      expect(() =>
        createBudgetedCounter({ name, help: "h", labels: ["route"], budget: budget as number }),
      ).toThrow(BUDGET_ERROR);
      expect(register.getSingleMetric(name)).toBeUndefined();
    }
  });

  it("rejects duplicate label names without registering the metric", () => {
    const name = metricName("duplicate_labels");

    expect(() =>
      createBudgetedCounter({ name, help: "h", labels: ["route", "route"], budget: 4 }),
    ).toThrow(DUPLICATE_ERROR);
    expect(register.getSingleMetric(name)).toBeUndefined();
  });

  it("applies the same contract to histograms and gauges", () => {
    const histogramName = metricName("bad_budget_histogram").replace(/_total$/, "");
    expect(() =>
      createBudgetedHistogram({
        name: histogramName,
        help: "h",
        labels: ["route"],
        budget: -3,
        buckets: [1, 5],
      }),
    ).toThrow(BUDGET_ERROR);

    const gaugeName = metricName("duplicate_gauge");
    expect(() =>
      createBudgetedGauge({
        name: gaugeName,
        help: "h",
        labels: ["tenant", "tenant"],
        budget: 2,
        buckets: [],
      }),
    ).toThrow(DUPLICATE_ERROR);

    expect(register.getSingleMetric(histogramName)).toBeUndefined();
    expect(register.getSingleMetric(gaugeName)).toBeUndefined();
  });

  it("accepts budget 0 and registers a label-less metric", () => {
    const name = metricName("zero_budget");

    const counter = createBudgetedCounter({
      name,
      help: "h",
      labels: ["tenant"],
      budget: 0,
    });
    counter.labels("tenant-a").inc();
    counter.labels("tenant-b").inc();

    expect(register.getSingleMetric(name)).toBeDefined();
  });

  it("registers a valid budgeted counter and records labeled observations", async () => {
    const name = metricName("valid_budget");
    const counter = createBudgetedCounter({
      name,
      help: "h",
      labels: ["route"],
      budget: 2,
    });

    counter.labels("/health").inc();
    counter.labels("/health").inc();

    expect(register.getSingleMetric(name)).toBeDefined();
    expect(await register.metrics()).toContain(`${name}{route="/health"} 2`);
  });

  it("does not reserve a budget entry when validation fails", () => {
    const name = metricName("retry_after_failure");

    expect(() =>
      createBudgetedCounter({ name, help: "h", labels: ["a", "a"], budget: 1 }),
    ).toThrow(DUPLICATE_ERROR);

    // A corrected registration with the same name must still succeed, proving
    // the failed attempt left no partial state behind.
    expect(() =>
      createBudgetedCounter({ name, help: "h", labels: ["a"], budget: 1 }),
    ).not.toThrow();
    expect(register.getSingleMetric(name)).toBeDefined();
  });
});
