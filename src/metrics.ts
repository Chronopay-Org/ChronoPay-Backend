// @ts-nocheck
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

export function createBudgetedGauge(options: BudgetedHistogramOptions): BudgetedLabelMetric<Gauge> {
  registerCardinalityBudget(options);
  const gauge = new Gauge({
    name: options.name,
    help: options.help,
    labelNames: options.budget === 0 ? [] : options.labels,
    registers: options.registers ?? [register],
  }) as BudgetedLabelMetric<Gauge>;

  gauge.labels = budgetedLabels(options.name, gauge);
  return gauge;
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
export const settlementsPendingFinality = createBudgetedGauge({
  name: "settlements_pending_finality",
  help: "Current number of settlements that are pending finality and awaiting reconcilation.",
  labels: [],
  budget: 0,
  registers: [register],
});

// ─── Timezone drift monitor metrics ───────────────────────────────────────────

/**
 * Gauge tracking the count of ambiguous slots (DST proximity, metadata issues)
 * per tenant and severity level.
 */
export const tzDriftAmbiguousSlots = createBudgetedGauge({
  name: "tz_drift_ambiguous_slots",
  help: "Number of slots with ambiguous timezone information grouped by tenant and severity",
  labels: ["tenant_id", "severity"],
  budget: 64,
  registers: [register],
});

/**
 * Gauge tracking the count of slots with missing timezone info
 * per tenant and severity level.
 */
export const tzDriftMissingTzSlots = createBudgetedGauge({
  name: "tz_drift_missing_tz_slots",
  help: "Number of slots with missing timezone offset information grouped by tenant and severity",
  labels: ["tenant_id", "severity"],
  budget: 64,
  registers: [register],
});

/**
 * Gauge storing the timestamp (epoch seconds) of the last completed
 * timezone drift scan. Alerts can reference this to detect stale runs.
 */
export const tzDriftLastScanTimestamp = createBudgetedGauge({
  name: "tz_drift_last_scan_timestamp_seconds",
  help: "Unix timestamp (seconds) of the last completed timezone drift scan",
  labels: [],
  budget: 0,
  registers: [register],
});

/**
 * Counter tracking the total number of slots scanned across all sweeps.
 */
export const tzDriftSlotsScannedTotal = createBudgetedCounter({
  name: "tz_drift_slots_scanned_total",
  help: "Total number of slots scanned by the timezone drift monitor",
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

// ─── Search cache warmup metrics ───────────────────────────────────────────────

export const searchCacheWarmupCoverageRatio = createBudgetedGauge({
  name: "search_cache_warmup_coverage_ratio",
  help: "Ratio of successfully warmed search queries to target top-N queries after taxonomy edit",
  labels: [],
  budget: 0,
  registers: [register],
});

export const searchCacheWarmupTotal = createBudgetedCounter({
  name: "search_cache_warmup_total",
  help: "Total number of search cache warmup runs triggered by taxonomy updates",
  labels: ["status"],
  budget: 8,
  registers: [register],
});

export const searchCacheWarmupQueriesTotal = createBudgetedCounter({
  name: "search_cache_warmup_queries_total",
  help: "Total number of search queries replayed during cache warmup",
  labels: ["result"],
  budget: 8,
  registers: [register],
});

export const searchCacheWarmupDurationSeconds = createBudgetedHistogram({
  name: "search_cache_warmup_duration_seconds",
  help: "Duration in seconds of search cache warmup runs",
  labels: [],
  budget: 0,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export function recordWarmupCoverage(ratio: number): void {
  searchCacheWarmupCoverageRatio.set(ratio);
}

export function recordWarmupExecution(status: "success" | "partial" | "failed" | "cancelled"): void {
  searchCacheWarmupTotal.labels(status).inc();
}

export function recordWarmupQueryReplayed(result: "success" | "failure"): void {
  searchCacheWarmupQueriesTotal.labels(result).inc();
}

export function recordWarmupDuration(durationSeconds: number): void {
  searchCacheWarmupDurationSeconds.observe(durationSeconds);
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

// ─── Outbox compaction metrics ────────────────────────────────────────────────

/**
 * Counter incremented for each row compacted (deleted) from the outbox table.
 */
export const outboxCompactionRowsDeleted = createBudgetedCounter({
  name: "outbox_compaction_rows_deleted_total",
  help: "Total number of acked outbox rows compacted (deleted) after retention window",
  labels: [],
  budget: 0,
  registers: [register],
});

/**
 * Counter incremented each time the compaction worker triggers the safety
 * brake (skips the run because candidate row count exceeds the threshold).
 */
export const outboxCompactionSafetyBrakeTriggers = createBudgetedCounter({
  name: "outbox_compaction_safety_brake_triggers_total",
  help: "Total number of outbox compaction runs skipped due to safety threshold",
  labels: [],
  budget: 0,
  registers: [register],
});

/**
 * Histogram tracking the duration (in milliseconds) of a single compaction sweep.
 */
export const outboxCompactionDurationMs = createBudgetedHistogram({
  name: "outbox_compaction_duration_ms",
  help: "Duration in milliseconds of an outbox compaction sweep",
  labels: [],
  budget: 0,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

export const reputationQueriesTotal = createBudgetedCounter({
  name: "reputation_queries_total",
  help: "Total number of reputation transparency queries grouped by tenant and result",
  labels: ["tenant_id", "result"],
  budget: 128,
  registers: [register],
});

export const reputationSmallCellSuppressionsTotal = createBudgetedCounter({
  name: "reputation_small_cell_suppressions_total",
  help: "Total number of reputation category suppressions due to small sample sizes",
  labels: ["tenant_id", "category"],
  budget: 128,
  registers: [register],
});

/**
 * Counter tracking which webhook HMAC key successfully verified a request.
 * Label `key_id` is cardinality-bounded via the budget mechanism.
 */
export const webhookHmacVerified = createBudgetedCounter({
  name: "webhook_hmac_verified_total",
  help: "Total number of webhook requests verified by a particular HMAC key id",
  labels: ["key_id"],
  budget: 8,
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

export function recordReputationQuery(
  tenantId: string,
  result: "success" | "unauthorized" | "not_found" | "forbidden",
): void {
  reputationQueriesTotal.labels(tenantId, result).inc();
}

export function recordSmallCellSuppression(tenantId: string, category: string): void {
  reputationSmallCellSuppressionsTotal.labels(tenantId, category).inc();
}

// ─── Query-budget breach metrics ─────────────────────────────────────────────

/**
 * Counter incremented each time a request-scoped query budget is exceeded.
 * Label `route` identifies which endpoint triggered the breach.
 */
export const queryBudgetBreaches = createBudgetedCounter({
  name: "db_query_budget_breaches_total",
  help: "Total number of per-request query budget breaches",
  labels: ["route"],
  budget: 64,
  registers: [register],
});

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
 * Counter incremented each time a query budget is breached.
 * Labelled by route so per-endpoint budget pressure is visible.
 */
export const queryBudgetBreaches = createBudgetedCounter({
  name: "query_budget_breaches_total",
  help: "Total number of per-request query budget breaches grouped by route",
  labels: ["route"],
  budget: 256,
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

// ─── Escrow drift reconciler metrics ──────────────────────────────────────────

/**
 * Gauge set to 1 when drift is detected between chain escrow state and local DB.
 */
export const escrowDriftDetected = createBudgetedGauge({
  name: "escrow_drift_detected",
  help: "Whether escrow state drift has been detected (1 = drift, 0 = clean)",
  labels: ["slot_id"],
  budget: 128,
  buckets: [],
  registers: [register],
});

/**
 * Counter incremented each time an escrow reader returns a result that
 * disagrees with the quorum majority for any slot.
 */
export const escrowReaderDisagreementTotal = createBudgetedCounter({
  name: "escrow_reader_disagreement_total",
  help: "Total number of reader disagreements observed during escrow drift reconciliation",
  labels: ["reader_id"],
  budget: 8,
  registers: [register],
});

/**
 * Counter incremented on each drift reconciliation tick.
 */
export const escrowDriftReconciliationTicks = createBudgetedCounter({
  name: "escrow_drift_reconciliation_ticks_total",
  help: "Total number of escrow drift reconciliation ticks performed",
  labels: [],
  budget: 0,
  registers: [register],
});

/**
 * Counter incremented each time a drift override is applied.
 */
export const escrowDriftOverridesApplied = createBudgetedCounter({
  name: "escrow_drift_overrides_applied_total",
  help: "Total number of manual escrow drift overrides applied",
  labels: ["slot_id"],
  budget: 64,
  registers: [register],
});

// ─── Query Budget Metrics ─────────────────────────────────────────────────────

/**
 * Counter incremented when a SQL query exceeds its per-request budget.
 * Label is the Express route pattern.
 */
export const queryBudgetBreaches = createBudgetedCounter({
  name: "query_budget_breaches_total",
  help: "Total number of SQL queries that exceeded their per-request budget (statement_timeout)",
  labels: ["route"],
  budget: 128,
  registers: [register],
});

/**
 * Histogram tracking per-request SQL wall-clock time in milliseconds.
 * Labels: route, outcome (ok | breached).
 */
export const queryBudgetSqlTimeMs = createBudgetedHistogram({
  name: "query_budget_sql_time_ms",
  help: "Per-request SQL execution time in milliseconds broken down by route and outcome",
  labels: ["route", "outcome"],
  budget: 256,
  buckets: [1, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
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

export const queryBudgetBreaches = createBudgetedCounter({
  name: "query_budget_breaches_total",
  help: "Total number of query budget breaches observed",
  labels: ["route"],
  budget: 32,
  registers: [register],
});

export const queryBudgetSqlTimeMs = createBudgetedHistogram({
  name: "query_budget_sql_time_ms",
  help: "Total SQL duration per query budget context in ms",
  labels: ["route"],
  budget: 32,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

