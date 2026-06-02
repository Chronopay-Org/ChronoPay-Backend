import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from "prom-client";
import { Request, Response, NextFunction } from "express";

/**
 * Prometheus metrics registry for the ChronoPay Backend.
 */
export const register = new Registry();

// Add default metrics (CPU, Memory, etc.) only outside tests.
// Jest can execute through node and may not set NODE_ENV=test in this repository,
// so also detect the Jest runner via process argv.
const isTestEnvironment =
  process.env.NODE_ENV === "test" ||
  typeof process.env.JEST_WORKER_ID !== "undefined" ||
  process.argv.some((arg) => typeof arg === "string" && arg.includes("jest"));

if (!isTestEnvironment) {
  collectDefaultMetrics({ register });
}

const OVERFLOW_LABEL_VALUE = "__overflow__";

type LabelValues = Record<string, string | number | boolean | null | undefined>;
type BudgetedLabelMetric<T> = T & {
  labels: (...values: Array<string | number | boolean | LabelValues>) => T;
};

interface CardinalityBudgetOptions {
  name: string;
  labels: string[];
  budget: number;
}

interface BudgetedCounterOptions extends CardinalityBudgetOptions {
  help: string;
  registers?: Registry[];
}

interface BudgetedHistogramOptions extends CardinalityBudgetOptions {
  help: string;
  buckets: number[];
  registers?: Registry[];
}

const metricLabelBudgets = new Map<string, {
  labels: string[];
  budget: number;
  seen: Map<string, string[]>;
}>();

let metricCardinalityOverflow: BudgetedLabelMetric<Counter>;

function assertValidBudget({ name, labels, budget }: CardinalityBudgetOptions): void {
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`Metric ${name} must declare a non-negative integer cardinality budget`);
  }

  const uniqueLabels = new Set(labels);
  if (uniqueLabels.size !== labels.length) {
    throw new Error(`Metric ${name} declares duplicate label names`);
  }
}

function registerCardinalityBudget(options: CardinalityBudgetOptions): void {
  assertValidBudget(options);
  metricLabelBudgets.set(options.name, {
    labels: [...options.labels],
    budget: options.budget,
    seen: new Map(),
  });
}

function normalizeLabelValues(labels: string[], values: Array<string | number | boolean | LabelValues>): string[] {
  if (values.length === 1 && typeof values[0] === "object" && values[0] !== null) {
    const labelObject = values[0] as LabelValues;
    return labels.map((label) => String(labelObject[label] ?? ""));
  }

  return labels.map((_, index) => String(values[index] ?? ""));
}

function boundedLabelValues(metricName: string, values: Array<string | number | boolean | LabelValues>): string[] {
  const state = metricLabelBudgets.get(metricName);
  if (!state || state.labels.length === 0 || state.budget === 0) {
    return [];
  }

  const normalized = normalizeLabelValues(state.labels, values);
  const key = JSON.stringify(normalized);

  if (state.seen.has(key)) {
    state.seen.delete(key);
    state.seen.set(key, normalized);
    return normalized;
  }

  if (state.seen.size < state.budget) {
    state.seen.set(key, normalized);
    return normalized;
  }

  if (metricName !== "metric_cardinality_overflow_total") {
    metricCardinalityOverflow.labels(metricName).inc();
  }
  return state.labels.map(() => OVERFLOW_LABEL_VALUE);
}

function budgetedLabels<T extends { labels: (...values: string[]) => T }>(
  metricName: string,
  metric: T,
): (...values: Array<string | number | boolean | LabelValues>) => T {
  const originalLabels = metric.labels.bind(metric);
  return (...values) => originalLabels(...boundedLabelValues(metricName, values));
}

export function createBudgetedCounter(options: BudgetedCounterOptions): BudgetedLabelMetric<Counter> {
  registerCardinalityBudget(options);
  const counter = new Counter({
    name: options.name,
    help: options.help,
    labelNames: options.budget === 0 ? [] : options.labels,
    registers: options.registers ?? [register],
  }) as BudgetedLabelMetric<Counter>;

  counter.labels = budgetedLabels(options.name, counter);
  return counter;
}

export function createBudgetedHistogram(options: BudgetedHistogramOptions): BudgetedLabelMetric<Histogram> {
  registerCardinalityBudget(options);
  const histogram = new Histogram({
    name: options.name,
    help: options.help,
    labelNames: options.budget === 0 ? [] : options.labels,
    buckets: options.buckets,
    registers: options.registers ?? [register],
  }) as BudgetedLabelMetric<Histogram>;

  histogram.labels = budgetedLabels(options.name, histogram);
  return histogram;
}

export function _resetMetricCardinalityState(): void {
  for (const state of metricLabelBudgets.values()) {
    state.seen.clear();
  }
}

metricCardinalityOverflow = createBudgetedCounter({
  name: "metric_cardinality_overflow_total",
  help: "Total number of metric observations relabeled after exceeding a cardinality budget",
  labels: ["metric"],
  budget: 256,
  registers: [register],
});

/**
 * Histogram to track HTTP request duration in seconds.
 */
let httpRequestDurationMicroseconds = register.getSingleMetric("http_request_duration_seconds") as Histogram;

if (!httpRequestDurationMicroseconds) {
  httpRequestDurationMicroseconds = createBudgetedHistogram({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labels: ["method", "route", "status_code"],
    budget: 128,
    buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10], // buckets for response time from 0.1s to 10s
    registers: [register],
  });
}

export { httpRequestDurationMicroseconds };

// ─── Slot cache metrics ───────────────────────────────────────────────────────

/**
 * Counter incremented on every slot-list cache HIT.
 */
export const slotCacheHits = createBudgetedCounter({
  name: "slot_cache_hits_total",
  help: "Total number of slot list cache hits",
  labels: [],
  budget: 0,
  registers: [register],
});

/**
 * Counter incremented on every slot-list cache MISS (origin fetch triggered).
 */
export const slotCacheMisses = createBudgetedCounter({
  name: "slot_cache_misses_total",
  help: "Total number of slot list cache misses",
  labels: [],
  budget: 0,
  registers: [register],
});

/**
 * Counter incremented each time a concurrent request is coalesced into an
 * existing in-flight fetch (stampede prevented).
 */
export const slotCacheStampedeBlocked = createBudgetedCounter({
  name: "slot_cache_stampede_blocked_total",
  help: "Total number of concurrent requests coalesced by single-flight stampede protection",
  labels: [],
  budget: 0,
  registers: [register],
});

/** Convenience helpers used by slotCache.ts */
export function recordCacheHit(): void {
  slotCacheHits.inc();
}

export function recordCacheMiss(): void {
  slotCacheMisses.inc();
}

export function recordStampedeBlocked(): void {
  slotCacheStampedeBlocked.inc();
}

export const dependencyFaults = createBudgetedCounter({
  name: "dependency_faults_total",
  help: "Total number of dependency faults observed by graceful-degradation handlers",
  labels: ["dependency", "fault"],
  budget: 12,
  registers: [register],
});

export const expiryCleanupBookingIntentsExpired = createBudgetedCounter({
  name: "expiry_cleanup_booking_intents_expired_total",
  help: "Total number of booking intents expired by the expiry cleanup worker",
  labels: [],
  budget: 0,
  registers: [register],
});

export const expiryCleanupCheckoutSessionsSoftExpired = createBudgetedCounter({
  name: "expiry_cleanup_checkout_sessions_soft_expired_total",
  help: "Total number of checkout sessions soft-expired by the expiry cleanup worker",
  labels: [],
  budget: 0,
  registers: [register],
});

export const expiryCleanupCheckoutSessionsDeleted = createBudgetedCounter({
  name: "expiry_cleanup_checkout_sessions_deleted_total",
  help: "Total number of orphaned checkout sessions deleted by the expiry cleanup worker",
  labels: [],
  budget: 0,
  registers: [register],
});

export const expiryCleanupSafetyBrakeTriggers = createBudgetedCounter({
  name: "expiry_cleanup_safety_brake_triggers_total",
  help: "Total number of expiry cleanup sweeps skipped because the candidate sweep size exceeded the safety threshold",
  labels: [],
  budget: 0,
  registers: [register],
});

export type DependencyFaultName =
  | "disconnect"
  | "timeout"
  | "pool_exhausted"
  | "cache_read"
  | "cache_write"
  | "cache_invalidate";

export function recordDependencyFault(
  dependency: "redis" | "db",
  fault: DependencyFaultName,
): void {
  dependencyFaults.labels(dependency, fault).inc();
}

// ─── Slow-query metrics ───────────────────────────────────────────────────────

/**
 * Counter incremented each time a query exceeds the slow-query threshold.
 */
export const slowQueryCounter = createBudgetedCounter({
  name: "db_slow_queries_total",
  help: "Total number of database queries that exceeded the slow-query threshold",
  labels: [],
  budget: 0,
  registers: [register],
});

/**
 * Histogram tracking duration (in milliseconds) of slow queries.
 */
export const slowQueryDuration = createBudgetedHistogram({
  name: "db_slow_query_duration_ms",
  help: "Duration in milliseconds of slow database queries",
  labels: [],
  budget: 0,
  buckets: [100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});

/**
 * Express middleware to track HTTP request duration.
 */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime();

  res.on("finish", () => {
    const duration = process.hrtime(start);
    const durationInSeconds = duration[0] + duration[1] / 1e9;
    
    // Use Express route patterns only; raw paths can contain user-controlled IDs.
    const route = req.route ? req.route.path : "__unmatched__";
    
    httpRequestDurationMicroseconds
      .labels(req.method, route, res.statusCode.toString())
      .observe(durationInSeconds);
  });

  next();
};
