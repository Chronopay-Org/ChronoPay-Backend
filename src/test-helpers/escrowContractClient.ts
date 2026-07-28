/**
 * Fake Escrow Contract Client (test helper)
 * -----------------------------------------
 *
 * A scripted in-memory escrow contract client used by tests. Lets callers
 * enqueue events in ledger order, advance the simulated tip, and inject
 * transient failures deterministically. Mirrors the `IEscrowContractClient`
 * shape so the listener treats it like a real client.
 *
 * Lives under `src/` so the TypeScript compiler's `rootDir` includes it and
 * tests can import it without `tsc` complaining about out-of-root imports.
 */

import type {
  IEscrowContractClient,
  GetEventsArgs,
  GetEventsResult,
} from "../scheduler/escrowContractClient.js";
import type {
  EscrowEvent,
  EscrowLedgerInfo,
} from "../scheduler/escrowEventTypes.js";

interface ScriptedEvent {
  ledgerSeq: number;
  event: EscrowEvent;
}

export interface FakeEscrowContractClientOptions {
  /** Initial tip ledger sequence. Listed events before this seq are not delivered. */
  startingTip?: number;
  /** Hard cap on events returned per page. Defaults to caller-provided limit. */
  pageCap?: number;
}

export class FakeEscrowContractClient implements IEscrowContractClient {
  private script: ScriptedEvent[] = [];
  private latestLedgerSeq: number;
  private latestCloseTime: string;
  private pageCap: number | undefined;
  private failNextGetEvents = 0;
  private failNextGetLatest = 0;

  constructor(options: FakeEscrowContractClientOptions = {}) {
    this.latestLedgerSeq = options.startingTip ?? 100;
    this.latestCloseTime = new Date(1_700_000_000_000).toISOString();
    this.pageCap = options.pageCap;
  }

  // ── Scripting helpers ─────────────────────────────────────────────────────

  enqueue(ledgerSeq: number, event: EscrowEvent): void {
    this.script.push({ ledgerSeq, event });
    this.script.sort(
      (a, b) =>
        a.ledgerSeq - b.ledgerSeq ||
        a.event.eventIndex - b.event.eventIndex,
    );
  }

  /**
   * Advance the simulated tip. Updates `latestCloseTime` if provided,
   * otherwise keeps the previous value.
   */
  advanceTip(ledgerSeq: number, closeTime?: string): void {
    if (ledgerSeq < this.latestLedgerSeq) {
      throw new Error(
        `tip cannot regress: ${this.latestLedgerSeq} -> ${ledgerSeq}`,
      );
    }
    this.latestLedgerSeq = ledgerSeq;
    if (closeTime) this.latestCloseTime = closeTime;
  }

  failNextGetEventsOnce(): void { this.failNextGetEvents += 1; }
  failNextGetLatestOnce(): void { this.failNextGetLatest += 1; }

  // ── IEscrowContractClient ─────────────────────────────────────────────────

  async getEvents(args: GetEventsArgs): Promise<GetEventsResult> {
    if (this.failNextGetEvents > 0) {
      this.failNextGetEvents -= 1;
      throw new Error("simulated getEvents transport failure");
    }
    const cap = this.pageCap ?? args.limit;
    const allow = args.contractAddresses && args.contractAddresses.length > 0
      ? new Set(args.contractAddresses)
      : null;
    const matching = this.script.filter(
      (entry) =>
        entry.ledgerSeq >= args.startLedger &&
        (allow === null || allow.has(entry.event.contractAddress)),
    );
    const page = matching.slice(0, cap);
    return {
      events: page.map((entry) => entry.event),
      latestLedgerSeq: this.latestLedgerSeq,
    };
  }

  async getLatestLedger(): Promise<EscrowLedgerInfo> {
    if (this.failNextGetLatest > 0) {
      this.failNextGetLatest -= 1;
      throw new Error("simulated getLatestLedger transport failure");
    }
    return {
      latestLedgerSeq: this.latestLedgerSeq,
      latestCloseTime: this.latestCloseTime,
    };
  }
}

/**
 * Soroban C-address made entirely of valid base32 characters. Computed at
 * module load to avoid length-counting bugs in literal copies shared between
 * tests.
 */
export const VALID_CONTRACT_ADDRESS = "C" + "A".repeat(55);
const BASE_TX_HASH = "a".repeat(64);

export function makeEvent(opts: Partial<EscrowEvent> & {
  kind: EscrowEvent["kind"];
  slotId: string;
  ledgerSeq: number;
  bookingIntentId?: string;
  txHash?: string;
  eventIndex?: number;
}): EscrowEvent {
  return {
    kind: opts.kind,
    slotId: opts.slotId,
    ledgerSeq: opts.ledgerSeq,
    txHash: opts.txHash ?? BASE_TX_HASH,
    eventIndex: opts.eventIndex ?? 0,
    closeTime:
      opts.closeTime ??
      new Date(1_700_000_000_000 + opts.ledgerSeq * 5_000).toISOString(),
    contractAddress: opts.contractAddress ?? VALID_CONTRACT_ADDRESS,
    bookingIntentId: opts.bookingIntentId,
    amount: opts.amount,
  };
}

/**
 * Produce a sequence of N events with distinct 64-char tx hashes, advancing
 * the ledger sequence by `ledgerStep`.
 */
export function makeSeries(opts: {
  count: number;
  kind: EscrowEvent["kind"];
  slotId: string;
  ledgerSeq: number;
  bookingIntentId?: string;
  ledgerStep?: number;
  txHashBase?: string;
}): EscrowEvent[] {
  const step = opts.ledgerStep ?? 1;
  return Array.from({ length: opts.count }, (_, i) => {
    const suffix = i.toString(16).padStart(8, "0");
    const base = (opts.txHashBase ?? "0123456789abcdef").slice(0, 16);
    const txHash = (base + suffix).padEnd(64, "0").slice(0, 64);
    return makeEvent({
      kind: opts.kind,
      slotId: opts.slotId,
      ledgerSeq: opts.ledgerSeq + i * step,
      bookingIntentId: opts.bookingIntentId,
      txHash,
      eventIndex: i,
    });
  });
}
