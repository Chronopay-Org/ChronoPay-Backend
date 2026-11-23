import {
  validateEscrowEvent,
  validateEscrowEventBatch,
  EscrowEventValidationError,
  eventKey,
  isEscrowEventKind,
} from "../scheduler/escrowEventTypes.js";

const VALID_TX = "a".repeat(64);
const SLOT_ID = "slot-11111111-1111-4111-8111-111111111111";
// Computed to avoid hand-counting bugs in literal copies of long base32
// C-addresses; the validator requires 1 'C' + 55 base32 chars.
const CONTRACT = "C" + "A".repeat(55);

function baseEvent(over: Record<string, unknown> = {}) {
  return {
    kind: "Held",
    txHash: VALID_TX,
    eventIndex: 0,
    ledgerSeq: 100,
    closeTime: "2024-01-01T00:00:00.000Z",
    contractAddress: CONTRACT,
    slotId: SLOT_ID,
    ...over,
  };
}

describe("isEscrowEventKind", () => {
  it("accepts the four supported kinds", () => {
    expect(isEscrowEventKind("Held")).toBe(true);
    expect(isEscrowEventKind("Released")).toBe(true);
    expect(isEscrowEventKind("Refunded")).toBe(true);
    expect(isEscrowEventKind("Slashed")).toBe(true);
  });

  it("rejects unknown kinds and non-strings", () => {
    expect(isEscrowEventKind("Ransomware")).toBe(false);
    expect(isEscrowEventKind(null)).toBe(false);
    expect(isEscrowEventKind(undefined)).toBe(false);
    expect(isEscrowEventKind(0)).toBe(false);
  });
});

describe("validateEscrowEvent", () => {
  it("accepts a well-formed event", () => {
    const e = validateEscrowEvent(baseEvent());
    expect(e).toMatchObject({
      kind: "Held",
      txHash: VALID_TX,
      eventIndex: 0,
      ledgerSeq: 100,
      slotId: SLOT_ID,
      contractAddress: CONTRACT,
    });
  });

  it("accepts optional bookingIntentId and amount when valid", () => {
    const e = validateEscrowEvent(
      baseEvent({ bookingIntentId: "intent-7", amount: "123450000" }),
    );
    expect(e.bookingIntentId).toBe("intent-7");
    expect(e.amount).toBe("123450000");
  });

  it("throws when the payload is not an object", () => {
    expect(() => validateEscrowEvent(null)).toThrow(EscrowEventValidationError);
    expect(() => validateEscrowEvent("hello")).toThrow(EscrowEventValidationError);
    expect(() => validateEscrowEvent([])).toThrow(EscrowEventValidationError);
  });

  it("rejects unknown event kinds", () => {
    expect(() => validateEscrowEvent(baseEvent({ kind: "Exploded" }))).toThrow(
      /Unknown event kind/,
    );
  });

  it("rejects malformed txHash", () => {
    expect(() => validateEscrowEvent(baseEvent({ txHash: "zz" }))).toThrow(/txHash/);
    expect(() => validateEscrowEvent(baseEvent({ txHash: 12 }))).toThrow(/txHash/);
  });

  it("rejects negative or non-integer eventIndex and ledgerSeq", () => {
    expect(() => validateEscrowEvent(baseEvent({ eventIndex: -1 }))).toThrow(/eventIndex/);
    expect(() => validateEscrowEvent(baseEvent({ eventIndex: 1.5 }))).toThrow(/eventIndex/);
    expect(() => validateEscrowEvent(baseEvent({ ledgerSeq: -10 }))).toThrow(/ledgerSeq/);
  });

  it("accepts numeric strings for eventIndex and ledgerSeq", () => {
    const e = validateEscrowEvent(
      baseEvent({ eventIndex: "3", ledgerSeq: "999" }),
    );
    expect(e.eventIndex).toBe(3);
    expect(e.ledgerSeq).toBe(999);
  });

  it("rejects malformed closeTime", () => {
    expect(() =>
      validateEscrowEvent(baseEvent({ closeTime: "not-a-date" })),
    ).toThrow(/closeTime/);
    expect(() => validateEscrowEvent(baseEvent({ closeTime: 12345 }))).toThrow(/closeTime/);
  });

  it("rejects invalid contract addresses", () => {
    expect(() =>
      validateEscrowEvent(baseEvent({ contractAddress: "GABC..." })),
    ).toThrow(/contractAddress/);
    expect(() =>
      validateEscrowEvent(baseEvent({ contractAddress: "tooshort" })),
    ).toThrow(/contractAddress/);
  });

  it("rejects malformed slotId", () => {
    expect(() =>
      validateEscrowEvent(baseEvent({ slotId: "slot-100" })),
    ).toThrow(/slotId/);
  });

  it("drops optional fields when malformed rather than throwing", () => {
    const e = validateEscrowEvent(
      baseEvent({ bookingIntentId: 12, amount: "not-a-decimal" }),
    );
    expect(e.bookingIntentId).toBeUndefined();
    expect(e.amount).toBeUndefined();
  });
});

describe("validateEscrowEventBatch", () => {
  it("parses a batch of valid events", () => {
    const result = validateEscrowEventBatch({
      events: [
        baseEvent({ txHash: "a".repeat(64), eventIndex: 0 }),
        baseEvent({ txHash: "b".repeat(64), eventIndex: 0, kind: "Released" }),
      ],
      latestLedgerSeq: 200,
    });
    expect(result.events).toHaveLength(2);
    expect(result.latestLedgerSeq).toBe(200);
  });

  it("rejects when events is not an array", () => {
    expect(() => validateEscrowEventBatch({ events: "no", latestLedgerSeq: 10 }))
      .toThrow(/events must be an array/);
  });

  it("rejects when latestLedgerSeq is invalid", () => {
    expect(() => validateEscrowEventBatch({ events: [], latestLedgerSeq: -1 }))
      .toThrow(/latestLedgerSeq/);
  });

  it("includes the offending index in the error message", () => {
    expect(() =>
      validateEscrowEventBatch({
        events: [baseEvent(), baseEvent({ ledgerSeq: "not-int" })],
        latestLedgerSeq: 100,
      }),
    ).toThrow(/Invalid event at index 1/);
  });
});

describe("eventKey", () => {
  it("lowercases the tx hash and joins with eventIndex", () => {
    expect(
      eventKey({ ...baseEvent({ txHash: "ABCD".repeat(16) }), eventIndex: 7 } as any),
    ).toBe(`${"abcd".repeat(16)}:7`);
  });
});
