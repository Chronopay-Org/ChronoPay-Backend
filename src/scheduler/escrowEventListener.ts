/**
 * Escrow Event Listener
 * ---------------------
 *
 * Consumes escrow contract events and projects them onto the local booking
 * model with strict idempotency. One tick does:
 *
 *   1. Read the cursor and ask the contract client for the current tip.
 *   2. Compute `safeTipSeq = tip - finalityDepth` (default 2 ledgers) so we
 *      only apply events that have reasonable finality.
 *   3. If the cursor is behind the safe tip, fetch a page starting at
 *      `cursor + 1` and apply events one by one.
 *   4. For each event:
 *        a. If the contract address is not in the allow-list → record a
 *           `noop_rejected_address` outcome and skip.
 *        b. Idempotency gate: claim `(txHash, eventIndex)`. If already
 *           claimed, skip and increment the duplicate counter.
 *        c. Project onto intent/slot state via `EscrowStateProjector`.
 *        d. On success (`applied` or `noop_*`), advance the local
 *           `maxProcessedSeq`.
 *        e. On failure, release the idempotency claim so we can retry
 *           cleanly on the next tick.
 *   5. After all events in the page are processed, persist
 *      `maxProcessedSeq` via the cursor store.
 *   6. Record lag, freshness, and SLO burn-rate metrics.
 *
 * The tick is safe to retry on partial failures. The cursor advances
 * AFTER every event is confirmed processed, and the idempotency gate
 * absorbs any re-attempt that crosses cursor advancement boundaries.
 */

import { recordRouteTraffic } from "../metrics/sloMetrics.js";
import { logError, logWarn } from "../utils/logger.js";
import {
  ESCROW_LISTENER_FINALITY_DEPTH,
  ESCROW_LISTENER_FRESHNESS_SLO_SECONDS,
  escrowListenerCursorAdvances,
  escrowListenerDuplicateHits,
  escrowListenerEventsProcessed,
  escrowListenerFreshnessSeconds,
  escrowListenerLagSequences,
  escrowListenerRollup,
  escrowListenerSlashedEvents,
  escrowListenerTickErrors,
} from "./escrowMetrics.js";
import type {
  IEscrowContractClient,
  GetEventsArgs,
} from "./escrowContractClient.js";
import type { CursorStore } from "./escrowCursorStore.js";
import type { IdempotencyStore } from "./escrowIdempotencyStore.js";
import {
  EscrowStateProjector,
  emptyProjectionCounts,
  type ProjectionCounts,
  type ProjectionOutcome,
} from "./escrowStateProjector.js";
import {
  eventKey,
  validateEscrowEventBatch,
  type EscrowParsedEventBatch,
} from "./escrowEventTypes.js";

export interface EscrowListenerOptions {
  /** Stable listener id, e.g. process hostname + worker role. */
  instanceId: string;
  contractClient: IEscrowContractClient;
  cursorStore: CursorStore;
  idempotencyStore: IdempotencyStore;
  projector: EscrowStateProjector;
  /** Allowlist of contract addresses whose events should be projected. */
  contractAddressAllowList?: ReadonlyArray<string>;
  /** Max events fetched per page. Default 100. */
  pageLimit?: number;
  /** Finality window in ledgers. Default 2. */
  finalityDepth?: number;
  /** Freshness SLO threshold, seconds. Default 60. */
  freshnessSloSeconds?: number;
  /** Sleep helper for the loop; overridable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Now provider; overridable for tests. */
  now?: () => number;
}

export interface EscrowListenerTickResult {
  instanceId: string;
  cursorBefore: number | null;
  cursorAfter: number | null;
  tipLedgerSeq: number;
  safeTipLedgerSeq: number;
  fetchedEvents: number;
  appliedEvents: number;
  duplicateIdempotencyHits: number;
  projectionCounts: ProjectionCounts;
  freshestAppliedCloseTime: string | null;
  freshnessSeconds: number | null;
  freshnessExceededSlo: boolean;
  lagSequences: number;
}

export const DEFAULT_PAGE_LIMIT = 100;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single tick of the escrow listener. Returns a result describing the
 * work performed so callers (CLI tools, tests) can inspect outcomes.
 *
 * Throws only on transport-level failures (network down, RPC error).
 * Projection-level no-ops are returned in `projectionCounts` without raising.
 */
export async function runEscrowListenerTick(
  options: EscrowListenerOptions,
): Promise<EscrowListenerTickResult> {
  const instanceId = options.instanceId;
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const finalityDepth = options.finalityDepth ?? ESCROW_LISTENER_FINALITY_DEPTH;
  const freshnessSloSeconds =
    options.freshnessSloSeconds ?? ESCROW_LISTENER_FRESHNESS_SLO_SECONDS;
  const allowList = options.contractAddressAllowList ?? [];
  const _sleep = options._sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  if (!Number.isInteger(pageLimit) || pageLimit <= 0) {
    throw new Error(`pageLimit must be a positive integer, received ${pageLimit}`);
  }
  if (!Number.isInteger(finalityDepth) || finalityDepth < 0) {
    throw new Error(`finalityDepth must be a non-negative integer, received ${finalityDepth}`);
  }

  escrowListenerRollup.recordTick();

  // ── Cursor before ──────────────────────────────────────────────────────────
  const cursorBefore = await options.cursorStore.get(instanceId);

  // ── Tip from contract ─────────────────────────────────────────────────────
  let tipLedgerSeq: number;
  try {
    const ledgerInfo = await options.contractClient.getLatestLedger();
    tipLedgerSeq = ledgerInfo.latestLedgerSeq;
    if (!Number.isInteger(tipLedgerSeq) || tipLedgerSeq < 0) {
      throw new Error(
        `getLatestLedger returned invalid latestLedgerSeq=${tipLedgerSeq}`,
      );
    }
  } catch (err) {
    escrowListenerTickErrors.labels("contract_call").inc();
    escrowListenerRollup.recordContractError();
    logError("[escrow-listener] getLatestLedger failed", {
      instanceId,
      error: errorMessage(err),
    });
    throw err;
  }

  const safeTipSeq = Math.max(0, tipLedgerSeq - finalityDepth);
  const initialLag =
    cursorBefore == null ? safeTipSeq : Math.max(0, safeTipSeq - cursorBefore);
  escrowListenerLagSequences.labels(instanceId).set(initialLag);

  // ── Empty page path ───────────────────────────────────────────────────────
  if (cursorBefore !== null && cursorBefore >= safeTipSeq) {
    return finalizeTickResult({
      instanceId,
      cursorBefore,
      cursorAfter: cursorBefore,
      tipLedgerSeq,
      safeTipSeq,
      fetchedEvents: 0,
      appliedEvents: 0,
      duplicateIdempotencyHits: 0,
      freshestAppliedCloseTime: null,
      now,
      freshnessSloSeconds,
      lagSequences: 0,
    });
  }

  // ── Fetch and validate page ───────────────────────────────────────────────
  const fetchArgs: GetEventsArgs = {
    startLedger: (cursorBefore ?? 0) + 1,
    limit: pageLimit,
    contractAddresses: [...allowList],
  };

  let batch: EscrowParsedEventBatch;
  try {
    const raw = await options.contractClient.getEvents(fetchArgs);
    batch = validateEscrowEventBatch(raw);
  } catch (err) {
    escrowListenerTickErrors.labels("contract_call").inc();
    escrowListenerRollup.recordContractError();
    logError("[escrow-listener] getEvents failed", {
      instanceId,
      error: errorMessage(err),
    });
    throw err;
  }

  // ── Apply events idempotently ─────────────────────────────────────────────
  const projectionCounts = emptyProjectionCounts();
  let maxProcessedSeq = cursorBefore ?? 0;
  let appliedEvents = 0;
  let duplicateIdempotencyHits = 0;
  let freshestAppliedCloseTime: string | null = null;
  let freshestAppliedSeq = 0;

  for (const event of batch.events) {
    if (event.ledgerSeq > safeTipSeq) {
      // Events past the finality window are intentionally not applied this
      // tick; they will be picked up on the next tick after they age into the
      // safe window. We DO NOT advance maxProcessedSeq past safeTipSeq so a
      // re-fetch after we catch up still returns these events in order.
      continue;
    }

    // Track cursor advance for every event that we have actually observed
    // regardless of outcome (applied, noop, or duplicate). Without this,
    // a crash-recovery replay where every event is a duplicate would leave
    // the cursor stuck on the previous value.
    if (event.ledgerSeq > maxProcessedSeq) {
      maxProcessedSeq = event.ledgerSeq;
    }

    const key = eventKey(event);
    const claimed = await options.idempotencyStore.claim(key);
    if (!claimed) {
      escrowListenerDuplicateHits.inc();
      escrowListenerRollup.recordDuplicateIdempotencyHit();
      duplicateIdempotencyHits += 1;
      projectionCounts.noop_slot_already += 1;
      continue;
    }

    let outcome: ProjectionOutcome;
    try {
      outcome = await options.projector.project(event);
    } catch (err) {
      // Release the idempotency claim so the next tick can retry cleanly.
      await safeRelease(options.idempotencyStore, key);
      escrowListenerTickErrors.labels("projection").inc();
      logError("[escrow-listener] projection threw", {
        instanceId,
        eventKey: key,
        error: errorMessage(err),
      });
      throw err;
    }

    incrementProjectionCount(projectionCounts, outcome.result);
    escrowListenerEventsProcessed.labels(event.kind, outcome.result).inc();
    maybeRecordRollup(outcome.result);

    if (outcome.result === "applied") {
      appliedEvents += 1;
      escrowListenerRollup.recordApplied();
      if (event.kind === "Slashed") {
        escrowListenerSlashedEvents.inc();
      }
      if (
        freshestAppliedCloseTime === null ||
        Date.parse(event.closeTime) > Date.parse(freshestAppliedCloseTime)
      ) {
        freshestAppliedCloseTime = event.closeTime;
        freshestAppliedSeq = event.ledgerSeq;
      }
    }

    if (outcome.result === "noop_rejected_address") {
      escrowListenerRollup.recordRejected();
    }
    // maxProcessedSeq update moved above so duplicates also advance the cursor.
  }

  // ── Advance cursor exactly once at end of batch ───────────────────────────
  let cursorAfter: number | null = maxProcessedSeq;
  if (maxProcessedSeq > (cursorBefore ?? 0)) {
    try {
      await options.cursorStore.set(instanceId, maxProcessedSeq);
      escrowListenerCursorAdvances.inc();
      escrowListenerRollup.recordCursorAdvance();
    } catch (err) {
      // Crucial: do NOT advance the cursor if the write fails. The events
      // we just applied are still safe (cached on idempotency store), but
      // we cannot guarantee the persisted cursor reflects them. On restart
      // we will re-fetch the same window and the idempotency store will
      // short-circuit them.
      cursorAfter = cursorBefore;
      escrowListenerTickErrors.labels("cursor_write").inc();
      logError("[escrow-listener] cursor write failed", {
        instanceId,
        attempted: maxProcessedSeq,
        error: errorMessage(err),
      });
      throw err;
    }
  }

  const lag = cursorAfter == null ? 0 : Math.max(0, safeTipSeq - cursorAfter);
  escrowListenerLagSequences.labels(instanceId).set(lag);

  return finalizeTickResult({
    instanceId,
    cursorBefore,
    cursorAfter,
    tipLedgerSeq,
    safeTipSeq,
    fetchedEvents: batch.events.length,
    appliedEvents,
    duplicateIdempotencyHits,
    freshestAppliedCloseTime,
    now,
    freshnessSloSeconds,
    lagSequences: lag,
    projectionCounts,
    freshestAppliedSeq,
  });
}

interface FinalizeArgs {
  instanceId: string;
  cursorBefore: number | null;
  cursorAfter: number | null;
  tipLedgerSeq: number;
  safeTipSeq: number;
  fetchedEvents: number;
  appliedEvents: number;
  duplicateIdempotencyHits: number;
  freshestAppliedCloseTime: string | null;
  now: () => number;
  freshnessSloSeconds: number;
  lagSequences: number;
  projectionCounts?: ProjectionCounts;
  freshestAppliedSeq?: number;
}

function finalizeTickResult(args: FinalizeArgs): EscrowListenerTickResult {
  let freshnessSeconds: number | null = null;
  if (args.freshestAppliedCloseTime !== null) {
    freshnessSeconds = Math.max(
      0,
      (args.now() - Date.parse(args.freshestAppliedCloseTime)) / 1000,
    );
  }

  let freshnessExceededSlo = false;
  if (freshnessSeconds !== null) {
    escrowListenerFreshnessSeconds.labels(args.instanceId).observe(freshnessSeconds);
    freshnessExceededSlo = freshnessSeconds > args.freshnessSloSeconds;
  } else {
    // No events applied this tick — we record false (the system is up to
    // date within the contract window). Real "staleness" SLO is computed at
    // the route level by recording per-tick verdicts across windows.
    freshnessExceededSlo = false;
  }
  recordRouteTraffic("escrow_listener", freshnessExceededSlo, args.now());

  return {
    instanceId: args.instanceId,
    cursorBefore: args.cursorBefore,
    cursorAfter: args.cursorAfter,
    tipLedgerSeq: args.tipLedgerSeq,
    safeTipLedgerSeq: args.safeTipSeq,
    fetchedEvents: args.fetchedEvents,
    appliedEvents: args.appliedEvents,
    duplicateIdempotencyHits: args.duplicateIdempotencyHits,
    projectionCounts: args.projectionCounts ?? emptyProjectionCounts(),
    freshestAppliedCloseTime: args.freshestAppliedCloseTime,
    freshnessSeconds,
    freshnessExceededSlo,
    lagSequences: args.lagSequences,
  };
}

function incrementProjectionCount(
  counts: ProjectionCounts,
  kind: ProjectionOutcome["result"],
): void {
  counts[kind] += 1;
}

function maybeRecordRollup(result: ProjectionOutcome["result"]): void {
  switch (result) {
    case "applied":
      break;
    case "noop_unknown_intent":
    case "noop_slot_already":
    case "noop_terminal_intent":
    case "noop_illegal_transition":
      escrowListenerRollup.recordNoop(result);
      break;
    case "noop_rejected_address":
      // already recorded at the listener boundary
      break;
  }
}

async function safeRelease(store: IdempotencyStore, key: string): Promise<void> {
  try {
    await store.release(key);
  } catch {
    // tolerate release failure — the idempotency entry will expire in 7 days
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Loop wrapper — runs ticks at a regular cadence (default 5s) until the
 * process is shut down. Each tick is independent; failures are isolated
 * (logged + counted) and the loop continues.
 */
export async function runEscrowListener(
  options: EscrowListenerOptions & {
    tickIntervalMs?: number;
    shouldStop?: () => boolean;
  },
): Promise<void> {
  const tickIntervalMs = options.tickIntervalMs ?? 5_000;
  const shouldStop = options.shouldStop ?? (() => false);
  const sleep = options.sleep ?? defaultSleep;

  while (!shouldStop()) {
    try {
      await runEscrowListenerTick(options);
    } catch (err) {
      logWarn("[escrow-listener] tick failed; will retry next interval", {
        instanceId: options.instanceId,
        error: errorMessage(err),
      });
    }
    if (shouldStop()) break;
    await sleep(tickIntervalMs);
  }
}
