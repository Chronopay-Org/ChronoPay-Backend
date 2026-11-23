/**
 * Escrow Listener Metrics
 * -----------------------
 *
 * Prometheus metrics and a small application-level rollup counter object.
 * The Prometheus metrics follow the cardinality-budget pattern used elsewhere
 * in the codebase (see `src/metrics.ts`); no user-controlled values appear as
 * label values, only the listener instance id and event kind / outcome.
 *
 * The rollup counters mirror the prom counters for use in unit tests, which
 * do not exercise the prom-client registry. Tests reset them in `beforeEach`.
 */

import {
  createBudgetedCounter,
  createBudgetedGauge,
  createBudgetedHistogram,
  register,
} from "../metrics.js";

export const ESCROW_LISTENER_INSTANCE_LABEL_BUDGET = 4;
export const ESCROW_LISTENER_FRESHNESS_SLO_SECONDS = 60;
export const ESCROW_LISTENER_FINALITY_DEPTH = 2;

export const escrowListenerEventsProcessed = createBudgetedCounter({
  name: "escrow_listener_events_processed_total",
  help:
    "Total escrow events processed by the listener, broken down by event kind and projection outcome",
  labels: ["event_kind", "outcome"],
  // 4 kinds × 7 outcomes, plus head-room for future outcomes.
  budget: 32,
  registers: [register],
});

export const escrowListenerLagSequences = createBudgetedGauge({
  name: "escrow_listener_lag_sequences",
  help:
    "Difference between the latest network ledger (after finalityDepth) and the cursor's last applied ledger sequence",
  labels: ["instance_id"],
  budget: ESCROW_LISTENER_INSTANCE_LABEL_BUDGET,
  // Gauges do not consume buckets, but the createBudgetedGauge signature
  // currently aliases BudgetedHistogramOptions — pass an empty array.
  buckets: [],
  registers: [register],
});

export const escrowListenerFreshnessSeconds = createBudgetedHistogram({
  name: "escrow_listener_freshness_seconds",
  help:
    "Wall-clock age (seconds) of the most-recent successfully applied escrow event — feeds the freshness SLO",
  labels: ["instance_id"],
  budget: ESCROW_LISTENER_INSTANCE_LABEL_BUDGET,
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [register],
});

export const escrowListenerSlashedEvents = createBudgetedCounter({
  name: "escrow_listener_slashed_events_total",
  help:
    "Total Slashed escrow events observed (alert-worthy; indicates a penalty was applied)",
  labels: [],
  budget: 0,
  registers: [register],
});

export const escrowListenerCursorAdvances = createBudgetedCounter({
  name: "escrow_listener_cursor_advances_total",
  help: "Total cursor advances performed by the listener (one per successful tick with events)",
  labels: [],
  budget: 0,
  registers: [register],
});

export const escrowListenerDuplicateHits = createBudgetedCounter({
  name: "escrow_listener_duplicate_idempotency_hits_total",
  help: "Total times the idempotency store reported an event had already been seen",
  labels: [],
  budget: 0,
  registers: [register],
});

export const escrowListenerTickErrors = createBudgetedCounter({
  name: "escrow_listener_tick_errors_total",
  help: "Total tick failures observed by the escrow listener",
  labels: ["error_type"],
  budget: 8,
  registers: [register],
});

// ─── Application-level rollup counters (for unit tests) ──────────────────────

interface RollupCounters {
  ticks: number;
  applied: number;
  cursorAdvances: number;
  duplicateIdempotencyHits: number;
  contractErrors: number;
  rejectedEvents: number;
  noopUnknownIntent: number;
  noopSlotAlready: number;
  noopTerminalIntent: number;
  noopIllegalTransition: number;
}

const _rollup: RollupCounters = {
  ticks: 0,
  applied: 0,
  cursorAdvances: 0,
  duplicateIdempotencyHits: 0,
  contractErrors: 0,
  rejectedEvents: 0,
  noopUnknownIntent: 0,
  noopSlotAlready: 0,
  noopTerminalIntent: 0,
  noopIllegalTransition: 0,
};

export const escrowListenerRollup = {
  recordTick(): void {
    _rollup.ticks += 1;
  },
  recordApplied(): void {
    _rollup.applied += 1;
  },
  recordCursorAdvance(): void {
    _rollup.cursorAdvances += 1;
  },
  recordDuplicateIdempotencyHit(): void {
    _rollup.duplicateIdempotencyHits += 1;
  },
  recordContractError(): void {
    _rollup.contractErrors += 1;
  },
  recordRejected(): void {
    _rollup.rejectedEvents += 1;
  },
  recordNoop(kind:
    | "noop_unknown_intent"
    | "noop_slot_already"
    | "noop_terminal_intent"
    | "noop_illegal_transition"): void {
    switch (kind) {
      case "noop_unknown_intent": _rollup.noopUnknownIntent += 1; break;
      case "noop_slot_already": _rollup.noopSlotAlready += 1; break;
      case "noop_terminal_intent": _rollup.noopTerminalIntent += 1; break;
      case "noop_illegal_transition": _rollup.noopIllegalTransition += 1; break;
    }
  },
  snapshot(): Readonly<RollupCounters> {
    return { ..._rollup };
  },
  reset(): void {
    _rollup.ticks = 0;
    _rollup.applied = 0;
    _rollup.cursorAdvances = 0;
    _rollup.duplicateIdempotencyHits = 0;
    _rollup.contractErrors = 0;
    _rollup.rejectedEvents = 0;
    _rollup.noopUnknownIntent = 0;
    _rollup.noopSlotAlready = 0;
    _rollup.noopTerminalIntent = 0;
    _rollup.noopIllegalTransition = 0;
  },
};
