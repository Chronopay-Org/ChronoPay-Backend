/**
 * Escrow Reader
 * -------------
 *
 * Narrow interface for reading escrow contract state from the Stellar network.
 * Each reader represents an independent Horizon endpoint that the reconciler
 * queries to build a quorum vote on the authoritative escrow state.
 *
 * The interface is intentionally minimal: it exposes only the read paths the
 * reconciler needs to compare chain state against the local DB. It does NOT
 * mutate state — that responsibility belongs to the EscrowDriftReconciler.
 */

import type { EscrowEvent, EscrowEventKind, EscrowLedgerInfo } from "../scheduler/escrowEventTypes.js";

export type { EscrowLedgerInfo } from "../scheduler/escrowEventTypes.js";

// ─── Domain types for the reconciler ─────────────────────────────────────────

/**
 * Summary of the latest known escrow event for a specific slot, as seen
 * by one reader. This is the unit of comparison for quorum voting.
 */
export interface SlotEscrowState {
  /** The slot id this state describes. */
  slotId: string;
  /** The latest escrow event kind applied to this slot, or null if no events exist. */
  latestEventKind: EscrowEventKind | null;
  /** The tx hash of the latest event, or null. */
  latestTxHash: string | null;
  /** The ledger sequence of the latest event, or -1. */
  latestLedgerSeq: number;
  /** The booking intent id referenced by the latest event, if any. */
  bookingIntentId: string | null;
  /** Total number of events seen for this slot. */
  eventCount: number;
}

/**
 * Full escrow state snapshot returned by a reader. Contains per-slot state
 * summaries and the network tip at read time.
 */
export interface EscrowStateSnapshot {
  /** Per-slot escrow state summaries. */
  slots: SlotEscrowState[];
  /** The ledger info at the time the snapshot was taken. */
  ledgerInfo: EscrowLedgerInfo;
  /** ISO 8601 timestamp when the snapshot was read. */
  readAt: string;
  /** Reader identifier for attribution. */
  readerId: string;
}

// ─── Reader interface ────────────────────────────────────────────────────────

export interface IEscrowReader {
  /** Unique human-readable identifier for this reader (e.g. "horizon-mainnet-1"). */
  readonly id: string;

  /**
   * Fetch all escrow events for a specific slot within a ledger range.
   * Returns events sorted by (ledgerSeq, eventIndex) ascending.
   */
  getSlotEvents(slotId: string, startLedger?: number): Promise<EscrowEvent[]>;

  /**
   * Return the latest ledger known to the network.
   */
  getLatestLedger(): Promise<EscrowLedgerInfo>;

  /**
   * Build a full escrow state snapshot — per-slot summaries for all known
   * slots within the given ledger range, plus the current network tip.
   */
  snapshot(slotIds: string[], startLedger?: number): Promise<EscrowStateSnapshot>;
}

// ─── Horizon-backed implementation ───────────────────────────────────────────

export interface HorizonEscrowReaderOptions {
  /** Unique identifier for this reader instance. */
  id: string;
  /** Full Horizon API base URL (e.g. https://horizon.stellar.org). */
  horizonUrl: string;
}

/**
 * Horizon-backed implementation of IEscrowReader.
 *
 * Uses the Horizon REST API to fetch escrow contract events. Each instance
 * is treated as an independent reader; the reconciler runs multiple instances
 * against different (or same) Horizon endpoints for quorum voting.
 */
export class HorizonEscrowReader implements IEscrowReader {
  public readonly id: string;
  private readonly horizonUrl: string;

  constructor(options: HorizonEscrowReaderOptions) {
    this.id = options.id;
    this.horizonUrl = options.horizonUrl.replace(/\/$/, "");
  }

  async getSlotEvents(slotId: string, startLedger?: number): Promise<EscrowEvent[]> {
    // In production, this would query a Horizon endpoint that indexes escrow
    // events by slot. For the reconciler, we fetch events in ledger range
    // and filter client-side. The interface supports a future index-backed
    // implementation without changing callers.
    const all = await this.fetchEvents(startLedger ?? 0);
    return all.filter((e) => e.slotId === slotId);
  }

  async getLatestLedger(): Promise<EscrowLedgerInfo> {
    const url = `${this.horizonUrl}/ledgers?limit=1&order=desc`;
    const response = await this.fetchJson<{
      _embedded: { records: Array<{ sequence: number; closed_at: string; protocol_version?: number }> };
    }>(url);

    const record = response._embedded.records[0];
    if (!record) {
      throw new Error(`[${this.id}] Horizon returned empty ledger list`);
    }

    return {
      latestLedgerSeq: record.sequence,
      latestCloseTime: record.closed_at,
      protocolVersion: record.protocol_version,
    };
  }

  async snapshot(slotIds: string[], startLedger?: number): Promise<EscrowStateSnapshot> {
    const ledgerInfo = await this.getLatestLedger();
    const startSeq = startLedger ?? 0;
    const allEvents = await this.fetchEvents(startSeq);

    // Group events by slot, keeping only the latest per slot
    const bySlot = new Map<string, EscrowEvent[]>();
    for (const event of allEvents) {
      if (!bySlot.has(event.slotId)) {
        bySlot.set(event.slotId, []);
      }
      bySlot.get(event.slotId)!.push(event);
    }

    const slots: SlotEscrowState[] = [];
    for (const slotId of slotIds) {
      const events = bySlot.get(slotId) ?? [];
      if (events.length === 0) {
        slots.push({
          slotId,
          latestEventKind: null,
          latestTxHash: null,
          latestLedgerSeq: -1,
          bookingIntentId: null,
          eventCount: 0,
        });
        continue;
      }

      // Events are already sorted by (ledgerSeq, eventIndex)
      const latest = events[events.length - 1];
      slots.push({
        slotId,
        latestEventKind: latest.kind,
        latestTxHash: latest.txHash,
        latestLedgerSeq: latest.ledgerSeq,
        bookingIntentId: latest.bookingIntentId ?? null,
        eventCount: events.length,
      });
    }

    return {
      slots,
      ledgerInfo,
      readAt: new Date().toISOString(),
      readerId: this.id,
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async fetchEvents(_startLedger: number): Promise<EscrowEvent[]> {
    // TODO: Wire to Soroban RPC getEvents when the escrow contract event
    // index is available. A production deployment MUST replace this stub
    // with a real RPC call that fetches, validates, and returns events.
    return [];
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": `chronopay-escrow-reader/${this.id}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `[${this.id}] Horizon HTTP ${response.status}: ${await response.text().catch(() => "unknown error")}`,
      );
    }

    return (await response.json()) as T;
  }
}
