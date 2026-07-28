/**
 * Escrow Event Types
 * ------------------
 *
 * Defines the canonical shape of an escrow domain event as observed on-chain,
 * the validators used at the listener boundary, and the wire-shape for a batch
 * returned from the `getEvents` JSON-RPC method.
 *
 * The four event kinds are emitted by the escrow contract and represent
 * authoritative lifecycle transitions of a buyer's escrow balance:
 *
 *   - `Held`     : buyer funds locked in escrow for a booking intent.
 *   - `Released` : escrow funds paid out to the supplier (service delivered).
 *   - `Refunded` : escrow funds returned to the buyer (dispute resolved).
 *   - `Slashed`  : escrow funds forfeited (protocol penalty applied).
 *
 * All events are immutable and identified by `(txHash, eventIndex)` —
 * that tuple is the natural idempotency key.
 */

export type EscrowEventKind = "Held" | "Released" | "Refunded" | "Slashed";

export interface EscrowEvent {
  readonly kind: EscrowEventKind;
  /** 64-character lowercase or uppercase hex (Stellar/Soroban tx hash). */
  readonly txHash: string;
  /** Position of the event within the transaction's emitted events. */
  readonly eventIndex: number;
  /** Ledger sequence (block number) in which the event was emitted. */
  readonly ledgerSeq: number;
  /** ISO 8601 close time of the ledger that contained the event. */
  readonly closeTime: string;
  /** Soroban C-address of the escrow contract that emitted the event. */
  readonly contractAddress: string;
  /** Id of the booking slot that the event projects onto. */
  readonly slotId: string;
  /** Booking intent id, if the contract annotates events with it. */
  readonly bookingIntentId?: string;
  /** Amount in the smallest currency unit (stroops). Optional. */
  readonly amount?: string;
}

export interface EscrowLedgerInfo {
  readonly latestLedgerSeq: number;
  readonly latestCloseTime: string;
  readonly protocolVersion?: number;
}

export interface EscrowRawEventBatch {
  readonly events: ReadonlyArray<Record<string, unknown>>;
  readonly latestLedgerSeq: number;
}

export interface EscrowParsedEventBatch {
  readonly events: EscrowEvent[];
  readonly latestLedgerSeq: number;
}

export class EscrowEventValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly value?: unknown,
  ) {
    super(message);
    this.name = "EscrowEventValidationError";
  }
}

const ESCROW_EVENT_KINDS: ReadonlySet<EscrowEventKind> = new Set<EscrowEventKind>([
  "Held",
  "Released",
  "Refunded",
  "Slashed",
]);

const TX_HASH_PATTERN = /^[0-9a-f]{64}$/i;
// Soroban C-contracts are encoded as a 'C' followed by 55 base32 chars.
const CONTRACT_ADDRESS_PATTERN = /^C[A-Z2-7]{55}$/;
const SLOT_ID_PATTERN = /^slot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?$/;

export function isEscrowEventKind(value: unknown): value is EscrowEventKind {
  return typeof value === "string" && ESCROW_EVENT_KINDS.has(value as EscrowEventKind);
}

/**
 * Stable, sortable identity key for a single escrow event. The tx hash is
 * lowercased so callers can compare across case mutations (RPCs may vary).
 */
export function eventKey(event: EscrowEvent): string {
  return `${event.txHash.toLowerCase()}:${event.eventIndex}`;
}

function asNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  throw new EscrowEventValidationError(`${field} must be a non-negative integer`, field, value);
}

export function validateEscrowEvent(raw: unknown): EscrowEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EscrowEventValidationError("Event payload must be an object");
  }
  const e = raw as Record<string, unknown>;

  if (!isEscrowEventKind(e.kind)) {
    throw new EscrowEventValidationError(
      `Unknown event kind: ${String(e.kind)}`,
      "kind",
      e.kind,
    );
  }

  if (typeof e.txHash !== "string" || !TX_HASH_PATTERN.test(e.txHash)) {
    throw new EscrowEventValidationError(
      "txHash must be a 64-character hex string",
      "txHash",
      e.txHash,
    );
  }

  const eventIndex = asNonNegativeInteger(e.eventIndex, "eventIndex");
  const ledgerSeq = asNonNegativeInteger(e.ledgerSeq, "ledgerSeq");

  if (typeof e.closeTime !== "string" || !ISO_8601_PATTERN.test(e.closeTime)) {
    throw new EscrowEventValidationError(
      "closeTime must be an ISO 8601 string",
      "closeTime",
      e.closeTime,
    );
  }
  if (Number.isNaN(Date.parse(e.closeTime))) {
    throw new EscrowEventValidationError(
      "closeTime must parse as a valid date",
      "closeTime",
      e.closeTime,
    );
  }

  if (typeof e.contractAddress !== "string" || !CONTRACT_ADDRESS_PATTERN.test(e.contractAddress)) {
    throw new EscrowEventValidationError(
      "contractAddress must be a valid Soroban C-address",
      "contractAddress",
      e.contractAddress,
    );
  }

  if (typeof e.slotId !== "string" || !SLOT_ID_PATTERN.test(e.slotId)) {
    throw new EscrowEventValidationError(
      "slotId format is invalid",
      "slotId",
      e.slotId,
    );
  }

  const bookingIntentId =
    typeof e.bookingIntentId === "string" && e.bookingIntentId.length > 0
      ? e.bookingIntentId
      : undefined;
  const amount =
    typeof e.amount === "string" && /^\d+$/.test(e.amount) ? e.amount : undefined;

  return {
    kind: e.kind,
    txHash: e.txHash,
    eventIndex,
    ledgerSeq,
    closeTime: e.closeTime,
    contractAddress: e.contractAddress,
    slotId: e.slotId,
    bookingIntentId,
    amount,
  };
}

export function validateEscrowEventBatch(raw: unknown): EscrowParsedEventBatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EscrowEventValidationError("Batch payload must be an object");
  }
  const b = raw as Record<string, unknown>;

  if (!Array.isArray(b.events)) {
    throw new EscrowEventValidationError("events must be an array", "events", b.events);
  }

  const latestLedgerSeq = asNonNegativeInteger(b.latestLedgerSeq, "latestLedgerSeq");

  const events: EscrowEvent[] = [];
  for (const [index, candidate] of (b.events as ReadonlyArray<unknown>).entries()) {
    try {
      events.push(validateEscrowEvent(candidate));
    } catch (err) {
      if (err instanceof EscrowEventValidationError) {
        throw new EscrowEventValidationError(
          `Invalid event at index ${index}: ${err.message}`,
          err.field,
          err.value,
        );
      }
      throw err;
    }
  }

  return { events, latestLedgerSeq };
}
