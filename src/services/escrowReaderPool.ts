/**
 * Escrow Reader Pool
 * ------------------
 *
 * Manages a pool of independent IEscrowReader instances and coordinates
 * quorum voting to determine the authoritative escrow state. The pool:
 *
 *   1. Queries ALL readers in parallel for the same snapshot.
 *   2. Compares their per-slot state summaries.
 *   3. Resolves disagreements via majority vote.
 *   4. Alarms when reader disagreement exceeds a configurable threshold.
 *
 * Vote aggregation:
 *   - For each slot, the "canonical" state is the one agreed upon by a
 *     simple majority (> 50%) of healthy readers.
 *   - If no majority exists ("hung jury"), the slot is flagged as
 *     `disputed` and an alarm is raised.
 *   - Individual reader disagreements are tracked via a counter metric.
 */

import { EventEmitter } from "node:events";
import type { IEscrowReader, SlotEscrowState, EscrowStateSnapshot } from "./escrowReader.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of comparing two SlotEscrowState values. */
export interface SlotStateComparison {
  slotId: string;
  /** True if all healthy readers agree on the latest event kind for this slot. */
  consensus: boolean;
  /** The majority-voted state, or null if no majority (hung jury). */
  majorityState: SlotEscrowState | null;
  /** Per-reader state values, keyed by reader id. */
  readerStates: Record<string, SlotEscrowState | null>;
  /** Number of readers that returned this slot. */
  readerCount: number;
  /** Number of readers that agree on the majority state. */
  agreeingReaders: number;
  /** True if the disagreement threshold was exceeded. */
  disagreementExceededThreshold: boolean;
}

export interface QuorumVoteResult {
  /** The snapshots returned by each healthy reader. */
  snapshots: EscrowStateSnapshot[];
  /** Per-slot comparisons with vote tallies. */
  slotComparisons: SlotStateComparison[];
  /** Set of reader ids that failed (errored or timed out). */
  failedReaderIds: string[];
  /** Total number of healthy readers that participated. */
  healthyReaderCount: number;
  /** Total slots evaluated. */
  totalSlots: number;
}

export interface EscrowReaderPoolOptions {
  /** Array of reader instances. Minimum 3 for meaningful quorum. */
  readers: IEscrowReader[];
  /**
   * Minimum fraction of readers that must agree for consensus.
   * Default 0.5 (simple majority). Must be > 0.5 for
   * unambiguous majority with 3+ readers.
   */
  quorumThreshold?: number;
  /**
   * Maximum fraction of readers that can disagree before an alarm fires.
   * Default 0.25 (if more than 25% disagree with majority on any slot).
   */
  disagreementThreshold?: number;
  /** Timeout in ms for each reader's snapshot call. Default 10_000. */
  readerTimeoutMs?: number;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface ReaderDisagreementEvent {
  type: "READER_DISAGREEMENT";
  slotId: string;
  readerIds: string[];
  majorityState: SlotEscrowState | null;
  disagreeingCount: number;
  totalReaders: number;
  message: string;
}

export interface HungJuryEvent {
  type: "HUNG_JURY";
  slotId: string;
  readerStates: Record<string, SlotEscrowState | null>;
  message: string;
}

export const readerPoolEvents = new EventEmitter();

// ─── Pool implementation ─────────────────────────────────────────────────────

export class EscrowReaderPool {
  private readonly readers: IEscrowReader[];
  private readonly quorumThreshold: number;
  private readonly disagreementThreshold: number;
  private readonly readerTimeoutMs: number;

  constructor(options: EscrowReaderPoolOptions) {
    if (options.readers.length < 3) {
      throw new Error(
        `EscrowReaderPool requires at least 3 readers for meaningful quorum, got ${options.readers.length}`,
      );
    }
    this.readers = [...options.readers];
    this.quorumThreshold = options.quorumThreshold ?? 0.5;
    this.disagreementThreshold = options.disagreementThreshold ?? 0.25;
    this.readerTimeoutMs = options.readerTimeoutMs ?? 10_000;

    if (this.quorumThreshold <= 0.5 && this.readers.length % 2 === 0) {
      throw new Error(
        `quorumThreshold must be > 0.5 for even-sized reader pools (got ${this.readers.length}) to avoid split-vote false majorities`,
      );
    }
  }

  get readerCount(): number {
    return this.readers.length;
  }

  /**
   * Query all readers in parallel and build a quorum vote result.
   *
   * Each reader returns a snapshot of escrow state. Failed readers
   * (errors, timeouts) are excluded from the quorum but recorded.
   */
  async vote(slotIds: string[], startLedger?: number): Promise<QuorumVoteResult> {
    const results = await Promise.allSettled(
      this.readers.map((reader) =>
        this.withTimeout(
          reader.snapshot(slotIds, startLedger),
          this.readerTimeoutMs,
          reader.id,
        ),
      ),
    );

    const snapshots: EscrowStateSnapshot[] = [];
    const failedReaderIds: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        snapshots.push(result.value);
      } else {
        failedReaderIds.push(this.readers[i].id);
      }
    }

    const healthyCount = snapshots.length;

    // Build slot comparisons
    const slotComparisons = this.buildSlotComparisons(
      slotIds,
      snapshots,
      healthyCount,
    );

    return {
      snapshots,
      slotComparisons,
      failedReaderIds,
      healthyReaderCount: healthyCount,
      totalSlots: slotIds.length,
    };
  }

  /**
   * Compute per-slot vote tallies and emit alarms for disagreements.
   */
  private buildSlotComparisons(
    slotIds: string[],
    snapshots: EscrowStateSnapshot[],
    healthyCount: number,
  ): SlotStateComparison[] {
    const comparisons: SlotStateComparison[] = [];

    for (const slotId of slotIds) {
      const readerStates: Record<string, SlotEscrowState | null> = {};

      // Collect each reader's state for this slot
      for (const snapshot of snapshots) {
        const slotState = snapshot.slots.find((s) => s.slotId === slotId) ?? null;
        readerStates[snapshot.readerId] = slotState;
      }

      // Tally votes: group by (latestEventKind, latestTxHash)
      const voteTally = new Map<string, { state: SlotEscrowState; count: number }>();
      for (const state of Object.values(readerStates)) {
        if (!state) continue;
        const key = `${state.latestEventKind ?? "none"}:${state.latestTxHash ?? "none"}`;
        const entry = voteTally.get(key);
        if (entry) {
          entry.count += 1;
        } else {
          voteTally.set(key, { state, count: 1 });
        }
      }

      // Find the majority state
      const sortedVotes = Array.from(voteTally.values()).sort((a, b) => b.count - a.count);
      const topVote = sortedVotes[0];
      const majorityRequired = Math.ceil(healthyCount * this.quorumThreshold);

      let majorityState: SlotEscrowState | null = null;
      let consensus = false;
      let agreeingReaders = 0;
      let disagreementExceededThreshold = false;

      if (topVote && topVote.count >= majorityRequired) {
        majorityState = topVote.state;
        agreeingReaders = topVote.count;
        consensus = topVote.count === healthyCount;
      }

      // Hung jury: no majority (takes precedence over disagreement)
      if (!majorityState && healthyCount > 0) {
        readerPoolEvents.emit("alert", {
          type: "HUNG_JURY",
          slotId,
          readerStates,
          message: `No quorum reached for slot ${slotId}: ${healthyCount} readers could not agree`,
        } satisfies HungJuryEvent);
        // When there's no majority, all readers effectively disagree
        disagreementExceededThreshold = healthyCount > 0;
      }

      // Check disagreement threshold (only when a majority exists)
      const disagreeingCount = healthyCount - agreeingReaders;
      if (
        majorityState &&
        healthyCount > 0 &&
        disagreeingCount / healthyCount > this.disagreementThreshold
      ) {
        disagreementExceededThreshold = true;

        readerPoolEvents.emit("alert", {
          type: "READER_DISAGREEMENT",
          slotId,
          readerIds: Object.entries(readerStates)
            .filter(([, s]) => s && (
              s.latestEventKind !== majorityState.latestEventKind ||
              s.latestTxHash !== majorityState.latestTxHash))
            .map(([id]) => id),
          majorityState,
          disagreeingCount,
          totalReaders: healthyCount,
          message: `Reader disagreement threshold exceeded for slot ${slotId}: ${disagreeingCount}/${healthyCount} readers disagree`,
        } satisfies ReaderDisagreementEvent);
      }

      comparisons.push({
        slotId,
        consensus,
        majorityState,
        readerStates,
        readerCount: healthyCount,
        agreeingReaders,
        disagreementExceededThreshold,
      });
    }

    return comparisons;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    readerId: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Reader '${readerId}' timed out after ${ms}ms`));
      }, ms);
    });

    try {
      const result = await Promise.race([promise, timeout]);
      clearTimeout(timer!);
      return result;
    } catch (err) {
      clearTimeout(timer!);
      throw err;
    }
  }
}
