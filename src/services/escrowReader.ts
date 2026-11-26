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

import { xdr, scValToNative } from "@stellar/stellar-sdk";
import {
  EscrowEventValidationError,
  validateEscrowEventBatch,
  type EscrowEvent,
  type EscrowEventKind,
  type EscrowLedgerInfo,
} from "../scheduler/escrowEventTypes.js";
import { escrowReaderMalformedEventsTotal } from "../metrics.js";
import { logger } from "../utils/logger.js";

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
  /** Soroban JSON-RPC endpoint URL for getEvents queries. */
  sorobanRpcUrl?: string;
  /** Soroban C-address of the escrow contract to filter events for. */
  contractId?: string;
  /** Maximum number of getEvents pages to fetch per read. Default 10. */
  maxPages?: number;
  /** Page size (pagination.limit) per getEvents request. Default 100. */
  pageLimit?: number;
  /** Optional fetch implementation (primarily for testing). */
  fetchFn?: typeof fetch;
}

interface SorobanRpcRawEvent {
  type?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  contractId?: string;
  id?: string;
  pagingToken?: string;
  txHash?: string;
  eventIndex?: number;
  topic?: unknown[];
  value?: unknown;
}

interface SorobanRpcGetEventsResult {
  events?: SorobanRpcRawEvent[];
  latestLedger?: number;
  cursor?: string;
}

interface SorobanRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_PAGE_LIMIT = 100;

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
  private readonly sorobanRpcUrl?: string;
  private readonly contractId?: string;
  private readonly maxPages: number;
  private readonly pageLimit: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: HorizonEscrowReaderOptions) {
    this.id = options.id;
    this.horizonUrl = options.horizonUrl.replace(/\/$/, "");
    this.sorobanRpcUrl = options.sorobanRpcUrl?.replace(/\/$/, "");
    this.contractId = options.contractId;
    this.maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
    this.pageLimit = Math.max(1, options.pageLimit ?? DEFAULT_PAGE_LIMIT);
    this.fetchFn = options.fetchFn ?? fetch;
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

  private async fetchEvents(startLedger: number): Promise<EscrowEvent[]> {
    if (!this.sorobanRpcUrl) {
      return [];
    }

    const collected: EscrowEvent[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < this.maxPages; page++) {
      const params: Record<string, unknown> = cursor
        ? { pagination: { cursor, limit: this.pageLimit } }
        : { startLedger, pagination: { limit: this.pageLimit } };

      if (this.contractId) {
        params.filters = [{ type: "contract", contractIds: [this.contractId] }];
      }

      const rpcResponse = await this.postJsonRpc<SorobanRpcGetEventsResult>(
        this.sorobanRpcUrl,
        "getEvents",
        params,
      );

      if (rpcResponse.error) {
        throw new Error(
          `[${this.id}] Soroban RPC getEvents error (${rpcResponse.error.code}): ${rpcResponse.error.message}`,
        );
      }

      const result = rpcResponse.result;
      if (!result || !Array.isArray(result.events)) {
        throw new Error(`[${this.id}] Soroban RPC getEvents returned invalid result payload`);
      }

      if (result.events.length === 0) {
        break;
      }

      const latestLedgerSeq = result.latestLedger ?? 0;
      const mapped = result.events.map((raw, idx) => this.mapRawRpcEvent(raw, idx));

      collected.push(...this.validatePageEvents(mapped, latestLedgerSeq));

      if (!result.cursor || result.cursor === cursor) {
        break;
      }
      cursor = result.cursor;
    }

    collected.sort((a, b) => a.ledgerSeq - b.ledgerSeq || a.eventIndex - b.eventIndex);
    return collected;
  }

  private validatePageEvents(
    candidates: Record<string, unknown>[],
    latestLedgerSeq: number,
  ): EscrowEvent[] {
    try {
      return validateEscrowEventBatch({ events: candidates, latestLedgerSeq }).events;
    } catch (err) {
      if (!(err instanceof EscrowEventValidationError)) {
        throw err;
      }
    }

    const valid: EscrowEvent[] = [];
    for (const candidate of candidates) {
      try {
        const parsed = validateEscrowEventBatch({
          events: [candidate],
          latestLedgerSeq,
        });
        valid.push(...parsed.events);
      } catch (err) {
        if (err instanceof EscrowEventValidationError) {
          escrowReaderMalformedEventsTotal.labels(this.id).inc();
          logger.warn(
            { readerId: this.id, field: err.field, error: err.message },
            `[${this.id}] Dropping malformed escrow event from RPC response`,
          );
          continue;
        }
        throw err;
      }
    }
    return valid;
  }

  private mapRawRpcEvent(raw: SorobanRpcRawEvent, fallbackIndex: number): Record<string, unknown> {
    const decodedTopics = Array.isArray(raw.topic) ? raw.topic.map(decodeScVal) : [];
    const decodedValue = decodeScVal(raw.value);
    const valueRecord =
      decodedValue && typeof decodedValue === "object" && !Array.isArray(decodedValue)
        ? (decodedValue as Record<string, unknown>)
        : {};

    const rawKind = decodedTopics[0] ?? valueRecord.kind;
    const kind = normalizeEventKind(rawKind);

    const slotId =
      valueRecord.slotId ??
      valueRecord.slot_id ??
      decodedTopics[1];

    const bookingIntentId =
      valueRecord.bookingIntentId ??
      valueRecord.booking_intent_id ??
      decodedTopics[2];

    const rawAmount = valueRecord.amount;
    const amount =
      rawAmount !== undefined && rawAmount !== null ? String(rawAmount) : undefined;

    const eventIndex =
      raw.eventIndex !== undefined
        ? raw.eventIndex
        : parseEventIndexFromId(raw.id ?? raw.pagingToken, fallbackIndex);

    return {
      kind,
      txHash: raw.txHash,
      eventIndex,
      ledgerSeq: raw.ledger,
      closeTime: raw.ledgerClosedAt,
      contractAddress: raw.contractId ?? this.contractId,
      slotId,
      bookingIntentId:
        typeof bookingIntentId === "string" && bookingIntentId.length > 0
          ? bookingIntentId
          : undefined,
      amount,
    };
  }

  private async postJsonRpc<T>(
    url: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<SorobanRpcResponse<T>> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": `chronopay-escrow-reader/${this.id}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `[${this.id}] Soroban RPC HTTP ${response.status}: ${await response.text().catch(() => "unknown error")}`,
      );
    }

    return (await response.json()) as SorobanRpcResponse<T>;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await this.fetchFn(url, {
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

function decodeScVal(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) {
    return raw;
  }
  try {
    const scVal = xdr.ScVal.fromXDR(raw, "base64");
    return scValToNative(scVal);
  } catch {
    return raw;
  }
}

function normalizeEventKind(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) {
    return raw;
  }
  const trimmed = raw.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function parseEventIndexFromId(id: string | undefined, fallback: number): number {
  if (typeof id === "string") {
    const dash = id.lastIndexOf("-");
    if (dash !== -1) {
      const parsed = Number.parseInt(id.slice(dash + 1), 10);
      if (Number.isInteger(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return fallback;
}
