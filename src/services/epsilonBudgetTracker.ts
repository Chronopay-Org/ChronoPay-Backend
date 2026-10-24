/**
 * epsilonBudgetTracker.ts
 * -----------------------
 * Tracks cumulative differential-privacy epsilon (ε) budget usage per dataset.
 *
 * # Privacy accounting model
 * Under sequential composition (the standard guarantee for DP), each time a
 * Laplace-noised query is answered with budget ε_i the *total* privacy loss
 * for that dataset grows to Σ ε_i. This tracker maintains that running sum
 * and emits structured warnings when usage crosses configurable thresholds.
 *
 * # Design choices
 * - State is kept **in-memory** (Map) so the tracker works without a database.
 *   For multi-instance deployments, callers can supply a custom
 *   {@link BudgetStore} backed by Redis or PostgreSQL.
 * - All mutating operations are **synchronous** by default via the in-memory
 *   store, but the interface is async-first so persistence backends can be
 *   swapped in without changing call sites.
 * - Alarm events are logged via an injected {@link BudgetAlarmSink} (defaults
 *   to console.warn) so the host application can route them to its own
 *   observability pipeline.
 *
 * # Epsilon budget configuration
 * Set per-dataset budgets via the `CHRONOPAY_DP_EPSILON_BUDGET_<DATASET>` env
 * var (e.g. `CHRONOPAY_DP_EPSILON_BUDGET_AUDIT_EVENTS=10`), or pass them
 * explicitly to the constructor.  The fallback default is controlled by
 * `DEFAULT_EPSILON_BUDGET` below.
 *
 * No I/O other than alarm sink calls. Fully unit-testable in isolation.
 */

import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default total epsilon budget per dataset when not overridden. */
export const DEFAULT_EPSILON_BUDGET = 10.0;

/**
 * Fraction of total budget at which a "budget warning" alarm fires.
 * At 80 % consumed the alarm level is "warning".
 */
export const BUDGET_WARNING_FRACTION = 0.8;

/**
 * Fraction of total budget at which a "budget exhausted" alarm fires.
 * At 100 % consumed the alarm level is "exhausted".
 */
export const BUDGET_EXHAUSTED_FRACTION = 1.0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BudgetAlarmLevel = "warning" | "exhausted";

export interface BudgetAlarmEvent {
  datasetId: string;
  level: BudgetAlarmLevel;
  epsilonSpent: number;
  epsilonBudget: number;
  fractionSpent: number;
  timestamp: string;
  message: string;
}

export interface BudgetEntry {
  datasetId: string;
  epsilonSpent: number;
  epsilonBudget: number;
  /** ISO-8601 timestamp of the first spend against this dataset. */
  firstSpendAt: string | null;
  /** ISO-8601 timestamp of the most recent spend. */
  lastSpendAt: string | null;
  /** Total number of query answers charged against this dataset. */
  queryCount: number;
}

export interface BudgetSpendRecord {
  datasetId: string;
  epsilonCharged: number;
  /** Cumulative epsilon spent after this charge. */
  totalEpsilonSpent: number;
  epsilonBudget: number;
  remainingBudget: number;
  alarmFired: BudgetAlarmLevel | null;
  timestamp: string;
}

/** Pluggable async storage interface for budget state. */
export interface BudgetStore {
  get(datasetId: string): Promise<BudgetEntry | null>;
  set(datasetId: string, entry: BudgetEntry): Promise<void>;
  all(): Promise<BudgetEntry[]>;
  delete(datasetId: string): Promise<void>;
}

/** Pluggable alarm sink. Receives alarm events for routing to observability. */
export type BudgetAlarmSink = (event: BudgetAlarmEvent) => void;

// ---------------------------------------------------------------------------
// In-memory BudgetStore (default)
// ---------------------------------------------------------------------------

export class InMemoryBudgetStore implements BudgetStore {
  private readonly data = new Map<string, BudgetEntry>();

  async get(datasetId: string): Promise<BudgetEntry | null> {
    const entry = this.data.get(datasetId);
    return entry ? { ...entry } : null;
  }

  async set(datasetId: string, entry: BudgetEntry): Promise<void> {
    this.data.set(datasetId, { ...entry });
  }

  async all(): Promise<BudgetEntry[]> {
    return Array.from(this.data.values()).map((e) => ({ ...e }));
  }

  async delete(datasetId: string): Promise<void> {
    this.data.delete(datasetId);
  }
}

// ---------------------------------------------------------------------------
// EpsilonBudgetTracker
// ---------------------------------------------------------------------------

export class EpsilonBudgetTracker {
  private readonly store: BudgetStore;
  private readonly alarmSink: BudgetAlarmSink;
  private readonly budgetOverrides: Map<string, number>;

  /**
   * @param store          - Persistence backend. Defaults to in-memory.
   * @param alarmSink      - Called when a budget alarm fires. Defaults to
   *                         console.warn so alarms are always visible.
   * @param budgetOverrides - Per-dataset epsilon budget caps keyed by datasetId.
   *                          Takes precedence over env-var config.
   */
  constructor(
    store: BudgetStore = new InMemoryBudgetStore(),
    alarmSink: BudgetAlarmSink = defaultAlarmSink,
    budgetOverrides: Record<string, number> = {},
  ) {
    this.store = store;
    this.alarmSink = alarmSink;
    this.budgetOverrides =
      new Map(Object.entries(budgetOverrides));
  }

  /**
   * Record an epsilon charge against a dataset and return a spend record.
   *
   * Throws {@link BudgetExhaustedError} when the new cumulative spend would
   * exceed the dataset's budget.  Callers should catch this and either refuse
   * the export or alert an operator.
   *
   * @param datasetId     - Stable identifier for the dataset (e.g. "audit_events").
   * @param epsilonCharged - The epsilon consumed by this query (must be > 0).
   */
  async charge(datasetId: string, epsilonCharged: number): Promise<BudgetSpendRecord> {
    if (!Number.isFinite(epsilonCharged) || epsilonCharged <= 0) {
      throw new BudgetTrackerError(
        `epsilonCharged must be a finite positive number, got: ${epsilonCharged}`,
      );
    }

    const budget = this.getBudgetFor(datasetId);
    const now = new Date().toISOString();

    // Load or initialise entry.
    let entry = await this.store.get(datasetId);
    if (!entry) {
      entry = {
        datasetId,
        epsilonSpent: 0,
        epsilonBudget: budget,
        firstSpendAt: null,
        lastSpendAt: null,
        queryCount: 0,
      };
    }

    const newSpent = entry.epsilonSpent + epsilonCharged;

    if (newSpent > budget) {
      throw new BudgetExhaustedError(datasetId, entry.epsilonSpent, budget);
    }

    // Update entry.
    const updatedEntry: BudgetEntry = {
      ...entry,
      epsilonSpent: newSpent,
      epsilonBudget: budget,
      firstSpendAt: entry.firstSpendAt ?? now,
      lastSpendAt: now,
      queryCount: entry.queryCount + 1,
    };
    await this.store.set(datasetId, updatedEntry);

    // Determine alarm level.
    const fraction = newSpent / budget;
    let alarmFired: BudgetAlarmLevel | null = null;

    if (fraction >= BUDGET_EXHAUSTED_FRACTION) {
      alarmFired = "exhausted";
      this.alarmSink(buildAlarmEvent(datasetId, "exhausted", newSpent, budget, now));
    } else if (fraction >= BUDGET_WARNING_FRACTION) {
      alarmFired = "warning";
      this.alarmSink(buildAlarmEvent(datasetId, "warning", newSpent, budget, now));
    }

    return {
      datasetId,
      epsilonCharged,
      totalEpsilonSpent: newSpent,
      epsilonBudget: budget,
      remainingBudget: budget - newSpent,
      alarmFired,
      timestamp: now,
    };
  }

  /**
   * Return the current budget entry for a dataset without modifying state.
   * Returns `null` when no spend has been recorded yet.
   */
  async getEntry(datasetId: string): Promise<BudgetEntry | null> {
    return this.store.get(datasetId);
  }

  /**
   * Return entries for all tracked datasets.
   */
  async getAllEntries(): Promise<BudgetEntry[]> {
    return this.store.all();
  }

  /**
   * Return the remaining epsilon budget for a dataset.
   * Returns the full budget when no spend has been recorded yet.
   */
  async remainingBudget(datasetId: string): Promise<number> {
    const entry = await this.store.get(datasetId);
    const budget = this.getBudgetFor(datasetId);
    if (!entry) return budget;
    return Math.max(0, budget - entry.epsilonSpent);
  }

  /**
   * Reset the accumulated spend for a dataset (e.g. for a new accounting
   * period). Does not reset the budget cap.
   */
  async resetSpend(datasetId: string): Promise<void> {
    const entry = await this.store.get(datasetId);
    if (!entry) return;
    await this.store.set(datasetId, {
      ...entry,
      epsilonSpent: 0,
      firstSpendAt: null,
      lastSpendAt: null,
      queryCount: 0,
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Resolve the epsilon budget for a dataset from overrides → env → default. */
  private getBudgetFor(datasetId: string): number {
    // 1. Explicit constructor override.
    if (this.budgetOverrides.has(datasetId)) {
      return this.budgetOverrides.get(datasetId)!;
    }

    // 2. Environment variable: CHRONOPAY_DP_EPSILON_BUDGET_<DATASET_UPPER>.
    const envKey = `CHRONOPAY_DP_EPSILON_BUDGET_${datasetId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const envVal = process.env[envKey];
    if (envVal !== undefined) {
      const parsed = Number(envVal);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    // 3. Global default.
    return DEFAULT_EPSILON_BUDGET;
  }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class BudgetExhaustedError extends Error {
  constructor(
    public readonly datasetId: string,
    public readonly epsilonSpent: number,
    public readonly epsilonBudget: number,
  ) {
    super(
      `Epsilon budget exhausted for dataset "${datasetId}": ` +
        `spent=${epsilonSpent.toFixed(4)}, budget=${epsilonBudget.toFixed(4)}`,
    );
    this.name = "BudgetExhaustedError";
  }
}

export class BudgetTrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetTrackerError";
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function buildAlarmEvent(
  datasetId: string,
  level: BudgetAlarmLevel,
  epsilonSpent: number,
  epsilonBudget: number,
  timestamp: string,
): BudgetAlarmEvent {
  const fractionSpent = epsilonSpent / epsilonBudget;
  const pct = (fractionSpent * 100).toFixed(1);
  const message =
    level === "exhausted"
      ? `[DP ALARM] Epsilon budget EXHAUSTED for dataset "${datasetId}" — ${pct}% used (${epsilonSpent.toFixed(4)} / ${epsilonBudget.toFixed(4)}). Further queries are blocked until budget is reset.`
      : `[DP ALARM] Epsilon budget WARNING for dataset "${datasetId}" — ${pct}% used (${epsilonSpent.toFixed(4)} / ${epsilonBudget.toFixed(4)}).`;
  return { datasetId, level, epsilonSpent, epsilonBudget, fractionSpent, timestamp, message };
}

function defaultAlarmSink(event: BudgetAlarmEvent): void {
  logger.warn({
    datasetId: event.datasetId,
    level: event.level,
    epsilonSpent: event.epsilonSpent,
    epsilonBudget: event.epsilonBudget,
    fractionSpent: event.fractionSpent,
    timestamp: event.timestamp,
  }, event.message);
}

// ---------------------------------------------------------------------------
// Singleton default instance
// ---------------------------------------------------------------------------

export const defaultEpsilonBudgetTracker = new EpsilonBudgetTracker();
