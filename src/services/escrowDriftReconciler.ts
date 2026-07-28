/**
 * Escrow Drift Reconciler
 * -----------------------
 *
 * Periodically compares escrow contract state (read via a quorum of
 * independent Horizon readers) against the local DB state. When drift is
 * detected the reconciler:
 *
 *   1. Emits the `escrow_drift_detected` metric.
 *   2. Logs a fatal-level alert with full forensic details.
 *   3. Emits an alarm event for downstream alerting.
 *   4. Queues the affected slot for manual review.
 *
 * A manual override endpoint (POST /api/v1/admin/escrow/drift/override)
 * allows an admin to force-update the local state after investigation.
 *
 * Architecture:
 *   - EscrowReaderPool  — quorum of independent Horizon readers
 *   - Local state repo  — the DB-backed view (booking intents + slots)
 *   - Periodic tick     — run every N seconds, start/stop lifecycle
 */

import { EventEmitter } from "node:events";
import { EscrowReaderPool } from "./escrowReaderPool.js";
import {
  escrowDriftDetected,
  escrowDriftOverridesApplied,
  escrowDriftReconciliationTicks,
  escrowReaderDisagreementTotal,
} from "../metrics.js";
import { logger } from "../utils/logger.js";
import type { SlotEscrowState } from "./escrowReader.js";

// ─── Local DB State ──────────────────────────────────────────────────────────

/**
 * The reconciler's view of local DB state for a slot.
 * This is intentionally minimal — only the fields needed for comparison.
 */
export interface LocalSlotState {
  slotId: string;
  /** The booking intent status in the local DB. */
  intentStatus: LocalIntentStatus | null;
  /** The latest known escrow tx hash in the local DB. */
  lastKnownTxHash: string | null;
  /** The latest known escrow event kind in the local DB. */
  lastKnownEventKind: string | null;
}

export type LocalIntentStatus = "pending" | "confirmed" | "cancelled" | "expired";

/**
 * Repository interface for querying local state. Callers provide a concrete
 * implementation backed by the real DB (or an in-memory mock for tests).
 */
export interface LocalStateRepository {
  /** Return all slot ids that have active escrow-linked booking intents. */
  getActiveSlotIds(): Promise<string[]>;
  /** Return the local state for a single slot. */
  getSlotState(slotId: string): Promise<LocalSlotState | null>;
  /**
   * Apply a manual override: update the local state to match the chain.
   * Returns the updated state.
   */
  applyOverride(
    slotId: string,
    targetStatus: LocalIntentStatus,
    reason: string,
  ): Promise<LocalSlotState>;
}

// ─── Drift result types ──────────────────────────────────────────────────────

export interface DriftedSlot {
  slotId: string;
  chainState: SlotEscrowState;
  localState: LocalSlotState;
  /** Human-readable description of the drift. */
  description: string;
}

export interface ReconcilerTickResult {
  /** Total active slots evaluated. */
  slotsEvaluated: number;
  /** Slots where the chain and local DB agree. */
  slotsInSync: number;
  /** Slots where drift was detected. */
  driftedSlots: DriftedSlot[];
  /** Number of reader failures during this tick. */
  readerFailures: number;
  /** ISO 8601 timestamp of the tick. */
  timestamp: string;
}

export const driftEvents = new EventEmitter();

export interface DriftDetectedEvent {
  type: "DRIFT_DETECTED";
  driftedSlots: DriftedSlot[];
  timestamp: string;
  message: string;
}

export interface ManualOverrideEvent {
  type: "MANUAL_OVERRIDE_APPLIED";
  slotId: string;
  previousStatus: string;
  newStatus: string;
  reason: string;
  actorIp: string;
  timestamp: string;
}

// ─── Reconciler ──────────────────────────────────────────────────────────────

export interface EscrowDriftReconcilerOptions {
  /** The reader pool for quorum-voted chain state. */
  readerPool: EscrowReaderPool;
  /** Local state repository. */
  localRepo: LocalStateRepository;
  /** Poll interval in ms. Default 60_000 (1 minute). */
  pollIntervalMs?: number;
  /**
   * Whether to auto-resolve drift by applying the chain state.
   * SECURITY: this should be false in production. Default false.
   */
  autoResolve?: boolean;
}

export class EscrowDriftReconciler {
  private readonly readerPool: EscrowReaderPool;
  private readonly localRepo: LocalStateRepository;
  private readonly pollIntervalMs: number;
  private readonly autoResolve: boolean;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(options: EscrowDriftReconcilerOptions) {
    this.readerPool = options.readerPool;
    this.localRepo = options.localRepo;
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.autoResolve = options.autoResolve ?? false;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.intervalId = setInterval(() => {
      void this.reconcile();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Perform one full reconciliation sweep.
   */
  async reconcile(): Promise<ReconcilerTickResult> {
    escrowDriftReconciliationTicks.inc();
    const timestamp = new Date().toISOString();

    let slotsEvaluated = 0;
    let slotsInSync = 0;
    const driftedSlots: DriftedSlot[] = [];
    let readerFailures = 0;

    // 1. Get active slot ids from local DB
    let slotIds: string[];
    try {
      slotIds = await this.localRepo.getActiveSlotIds();
    } catch (err: any) {
      logger.warn(
        { error: err.message },
        "EscrowDriftReconciler: failed to fetch active slot ids from local repo. Skipping tick.",
      );
      return {
        slotsEvaluated: 0,
        slotsInSync: 0,
        driftedSlots: [],
        readerFailures: 0,
        timestamp,
      };
    }

    if (slotIds.length === 0) {
      return { slotsEvaluated: 0, slotsInSync: 0, driftedSlots: [], readerFailures: 0, timestamp };
    }

    // 2. Get quorum-voted chain state
    const voteResult = await this.readerPool.vote(slotIds);
    readerFailures = voteResult.failedReaderIds.length;

    // Track reader disagreements
    for (const comparison of voteResult.slotComparisons) {
      if (comparison.disagreementExceededThreshold) {
        const disagreeingIds = Object.entries(comparison.readerStates)
          .filter(([, s]) => {
            if (!s) return true;
            if (!comparison.majorityState) return true;
            return (
              s.latestEventKind !== comparison.majorityState.latestEventKind ||
              s.latestTxHash !== comparison.majorityState.latestTxHash
            );
          })
          .map(([id]) => id);
        for (const readerId of disagreeingIds) {
          escrowReaderDisagreementTotal.labels(readerId).inc();
        }
      }
    }

    // 3. Compare chain vs local for each slot
    for (const comparison of voteResult.slotComparisons) {
      slotsEvaluated++;

      const chainState = comparison.majorityState;
      const localState = await this.localRepo.getSlotState(comparison.slotId);

      if (!localState) {
        // Slot doesn't exist locally — not drift, slot may have been cleaned up
        slotsInSync++;
        continue;
      }

      if (!chainState) {
        // Hung jury — no reliable chain state to compare against
        // Still count as evaluated but not in sync
        const description = `No quorum reached for slot ${comparison.slotId}; cannot compare chain vs local state`;
        logger.warn({ slotId: comparison.slotId }, description);
        driftedSlots.push({
          slotId: comparison.slotId,
          chainState: {
            slotId: comparison.slotId,
            latestEventKind: null,
            latestTxHash: null,
            latestLedgerSeq: -1,
            bookingIntentId: null,
            eventCount: 0,
          },
          localState,
          description,
        });
        escrowDriftDetected.labels(comparison.slotId).set(1);
        continue;
      }

      const drifted = this.compareStates(comparison.slotId, chainState, localState);
      if (drifted) {
        driftedSlots.push(drifted);
        escrowDriftDetected.labels(comparison.slotId).set(1);
      } else {
        slotsInSync++;
        escrowDriftDetected.labels(comparison.slotId).set(0);
      }
    }

    // 4. Emit drift alert if any slots drifted
    if (driftedSlots.length > 0) {
      const event: DriftDetectedEvent = {
        type: "DRIFT_DETECTED",
        driftedSlots,
        timestamp,
        message: `Escrow state drift detected for ${driftedSlots.length} slot(s): ${driftedSlots.map((s) => s.slotId).join(", ")}`,
      };

      logger.fatal(
        { driftedSlotIds: driftedSlots.map((s) => s.slotId) },
        event.message,
      );

      driftEvents.emit("alert", event);
    }

    return { slotsEvaluated, slotsInSync, driftedSlots, readerFailures, timestamp };
  }

  /**
   * Compare a single slot's chain state against its local DB state.
   * Returns a DriftedSlot if there's a discrepancy, null if in sync.
   */
  private compareStates(
    slotId: string,
    chainState: SlotEscrowState,
    localState: LocalSlotState,
  ): DriftedSlot | null {
    const expectedStatus = mapChainEventToIntentStatus(chainState.latestEventKind);

    // Check 1: chain has events, local has none (structural drift — no tx hash in DB)
    if (chainState.latestTxHash !== null && localState.lastKnownTxHash === null) {
      return {
        slotId,
        chainState,
        localState,
        description: `Chain has event tx ${chainState.latestTxHash} but local DB has no escrow events for this slot`,
      };
    }

    // Check 2: local has events, chain has none (DB ahead of chain — possible fork/reorg)
    if (chainState.latestTxHash === null && localState.lastKnownTxHash !== null) {
      return {
        slotId,
        chainState,
        localState,
        description: `Local DB has event tx ${localState.lastKnownTxHash} but chain has no escrow events for this slot (possible reorg)`,
      };
    }

    // Check 3: tx hash mismatch (both have events but different hashes)
    if (
      chainState.latestTxHash !== null &&
      localState.lastKnownTxHash !== null &&
      chainState.latestTxHash !== localState.lastKnownTxHash
    ) {
      return {
        slotId,
        chainState,
        localState,
        description: `Tx hash mismatch: chain has ${chainState.latestTxHash} but local DB has ${localState.lastKnownTxHash}`,
      };
    }

    // Check 4: intent status mismatch (same event, diverging projection)
    if (expectedStatus !== null && localState.intentStatus !== null && expectedStatus !== localState.intentStatus) {
      return {
        slotId,
        chainState,
        localState,
        description: `Intent status mismatch: chain expects "${expectedStatus}" (event ${chainState.latestEventKind}) but local DB has "${localState.intentStatus}"`,
      };
    }

    return null;
  }

  /**
   * Apply a manual override to force local state to match chain state.
   * This is called by the admin endpoint, not automatically.
   */
  async manualOverride(
    slotId: string,
    targetStatus: LocalIntentStatus,
    reason: string,
    actorIp: string,
  ): Promise<{ previousState: LocalSlotState | null; newState: LocalSlotState }> {
    const previousState = await this.localRepo.getSlotState(slotId);

    const newState = await this.localRepo.applyOverride(slotId, targetStatus, reason);

    // Emit metric and event
    escrowDriftOverridesApplied.labels(slotId).inc();
    escrowDriftDetected.labels(slotId).set(0);

    const event: ManualOverrideEvent = {
      type: "MANUAL_OVERRIDE_APPLIED",
      slotId,
      previousStatus: previousState?.intentStatus ?? "unknown",
      newStatus: targetStatus,
      reason,
      actorIp,
      timestamp: new Date().toISOString(),
    };
    driftEvents.emit("alert", event);

    logger.warn(
      {
        slotId,
        previousStatus: previousState?.intentStatus,
        newStatus: targetStatus,
        reason,
        actorIp,
      },
      "Manual escrow drift override applied",
    );

    return { previousState, newState };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Map an escrow event kind to the expected booking intent status.
 * Based on the state machine in EscrowStateProjector.
 */
export function mapChainEventToIntentStatus(
  eventKind: string | null,
): LocalIntentStatus | null {
  switch (eventKind) {
    case "Held":
      return "confirmed";
    case "Released":
    case "Refunded":
      return "cancelled";
    case "Slashed":
      return "expired";
    default:
      return null; // No chain events = no expected status
  }
}
