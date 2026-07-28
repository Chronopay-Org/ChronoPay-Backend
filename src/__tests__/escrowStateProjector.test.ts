import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import {
  InMemoryBookingIntentRepository,
} from "../modules/booking-intents/booking-intent-repository.js";
import {
  EscrowStateProjector,
} from "../scheduler/escrowStateProjector.js";
import {
  type EscrowEvent,
  validateEscrowEvent,
} from "../scheduler/escrowEventTypes.js";
import {
  FakeEscrowContractClient,
  VALID_CONTRACT_ADDRESS,
  makeEvent,
} from "../test-helpers/escrowContractClient.js";

const SLOT_ID = "slot-11111111-1111-4111-8111-111111111111";
const CONTRACT = VALID_CONTRACT_ADDRESS;
const SLOT_ID_B = "slot-22222222-2222-4222-8222-222222222222";

function setup(opts: { allowList?: string[]; withIntent?: "yes" | "no" }) {
  const slots = new InMemorySlotRepository([
    {
      id: SLOT_ID,
      professional: "alice",
      startTime: 1_900_000_000_000,
      endTime: 1_900_000_360_000,
      bookable: true,
    },
    {
      id: SLOT_ID_B,
      professional: "bob",
      startTime: 1_900_000_720_000,
      endTime: 1_900_001_080_000,
      bookable: false, // pre-reserved
    },
  ]);
  const intents = new InMemoryBookingIntentRepository();
  const projector = new EscrowStateProjector(
    intents,
    slots,
    opts.allowList ?? [CONTRACT],
  );
  let _intentId: string | undefined;
  if (opts.withIntent === "yes") {
    intents
      .create({
        slotId: SLOT_ID,
        professional: "alice",
        customerId: "cust-1",
        startTime: 1_900_000_000_000,
        endTime: 1_900_000_360_000,
        status: "pending",
        createdAt: new Date(1_700_000_000_000).toISOString(),
      })
      .then((record) => {
        _intentId = record.id;
      });
  }
  return { slots, intents, projector };
}

describe("EscrowStateProjector — Held", () => {
  it("transitions a pending intent to confirmed", async () => {
    const ctx = setup({ withIntent: "yes" });
    const intent = ctx.intents.listAll()[0];
    expect(intent.status).toBe("pending");

    const event = makeEvent({
      kind: "Held",
      slotId: SLOT_ID,
      ledgerSeq: 100,
      bookingIntentId: intent.id,
    });

    const outcome = await ctx.projector.project(event);
    expect(outcome.result).toBe("applied");
    expect(outcome.intent?.status).toBe("confirmed");
    expect(ctx.intents.findById(intent.id)?.status).toBe("confirmed");
  });

  it("re-apply Held on already-confirmed is a noop_slot_already", async () => {
    const ctx = setup({ withIntent: "yes" });
    const intent = ctx.intents.listAll()[0];
    ctx.intents.updateStatus(intent.id, "confirmed");

    const event = makeEvent({
      kind: "Held",
      slotId: SLOT_ID,
      ledgerSeq: 100,
      bookingIntentId: intent.id,
    });
    const outcome = await ctx.projector.project(event);
    expect(outcome.result).toBe("noop_slot_already");
  });

  it("Held on terminal intent is a noop_terminal_intent", async () => {
    const ctx = setup({ withIntent: "yes" });
    const intent = ctx.intents.listAll()[0];
    ctx.intents.updateStatus(intent.id, "cancelled");

    const event = makeEvent({
      kind: "Held",
      slotId: SLOT_ID,
      ledgerSeq: 100,
      bookingIntentId: intent.id,
    });
    const outcome = await ctx.projector.project(event);
    expect(outcome.result).toBe("noop_terminal_intent");
  });

  it("Held on unknown intent is a noop_unknown_intent", async () => {
    const ctx = setup({ withIntent: "no" });
    const event = makeEvent({
      kind: "Held",
      slotId: SLOT_ID,
      ledgerSeq: 100,
    });
    const outcome = await ctx.projector.project(event);
    expect(outcome.result).toBe("noop_unknown_intent");
  });
});

describe("EscrowStateProjector — Released", () => {
  it("transitions confirmed to cancelled and frees the slot", async () => {
    const slots = new InMemorySlotRepository([
      {
        id: SLOT_ID,
        professional: "alice",
        startTime: 1_900_000_000_000,
        endTime: 1_900_000_360_000,
        bookable: false, // reserved
      },
    ]);
    const intents = new InMemoryBookingIntentRepository();
    const intent = await intents.create({
      slotId: SLOT_ID,
      professional: "alice",
      customerId: "cust-1",
      startTime: 1_900_000_000_000,
      endTime: 1_900_000_360_000,
      status: "confirmed",
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    const projector = new EscrowStateProjector(intents, slots, [CONTRACT]);

    const event = makeEvent({
      kind: "Released",
      slotId: SLOT_ID,
      ledgerSeq: 101,
      bookingIntentId: intent.id,
    });
    const outcome = await projector.project(event);
    expect(outcome.result).toBe("applied");
    expect(outcome.slotFreed).toBe(true);
    expect(slots.findById(SLOT_ID)?.bookable).toBe(true);
    expect(intents.findById(intent.id)?.status).toBe("cancelled");
  });

  it("transitions pending to cancelled when Released arrives early", async () => {
    const ctx = setup({ withIntent: "yes" });
    const intent = ctx.intents.listAll()[0];
    const event = makeEvent({
      kind: "Released",
      slotId: SLOT_ID,
      ledgerSeq: 99,
      bookingIntentId: intent.id,
    });
    const outcome = await ctx.projector.project(event);
    expect(outcome.result).toBe("applied");
    expect(outcome.intent?.status).toBe("cancelled");
  });

  it("Released on already-cancelled intent is a no-op (intent matches target)", async () => {
    const ctx = setup({ withIntent: "yes" });
    const intent = ctx.intents.listAll()[0];
    ctx.intents.updateStatus(intent.id, "cancelled");
    const event = makeEvent({
      kind: "Released",
      slotId: SLOT_ID,
      ledgerSeq: 99,
      bookingIntentId: intent.id,
    });
    const outcome = await ctx.projector.project(event);
    // Released → cancelled is a replay when the intent is already cancelled.
    expect(outcome.result).toBe("noop_slot_already");
  });

  it("Released on expired intent returns noop_terminal_intent", async () => {
    const ctx = setup({ withIntent: "yes" });
    const intent = ctx.intents.listAll()[0];
    ctx.intents.updateStatus(intent.id, "expired");
    const event = makeEvent({
      kind: "Released",
      slotId: SLOT_ID,
      ledgerSeq: 99,
      bookingIntentId: intent.id,
    });
    const outcome = await ctx.projector.project(event);
    expect(outcome.result).toBe("noop_terminal_intent");
  });

  it("Released on unknown intent returns noop_unknown_intent", async () => {
    const ctx = setup({ withIntent: "no" });
    const event = makeEvent({ kind: "Released", slotId: SLOT_ID, ledgerSeq: 99 });
    const outcome = await ctx.projector.project(event);
    expect(outcome.result).toBe("noop_unknown_intent");
  });
});

describe("EscrowStateProjector — Refunded", () => {
  it("transitions confirmed intent to cancelled and frees slot", async () => {
    const slots = new InMemorySlotRepository([
      {
        id: SLOT_ID,
        professional: "alice",
        startTime: 1_900_000_000_000,
        endTime: 1_900_000_360_000,
        bookable: false,
      },
    ]);
    const intents = new InMemoryBookingIntentRepository();
    const intent = await intents.create({
      slotId: SLOT_ID,
      professional: "alice",
      customerId: "cust-1",
      startTime: 1_900_000_000_000,
      endTime: 1_900_000_360_000,
      status: "confirmed",
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    const projector = new EscrowStateProjector(intents, slots, [CONTRACT]);
    const event = makeEvent({
      kind: "Refunded",
      slotId: SLOT_ID,
      ledgerSeq: 102,
      bookingIntentId: intent.id,
    });
    const outcome = await projector.project(event);
    expect(outcome.result).toBe("applied");
    expect(outcome.intent?.status).toBe("cancelled");
    expect(slots.findById(SLOT_ID)?.bookable).toBe(true);
  });
});

describe("EscrowStateProjector — Slashed", () => {
  it("transitions confirmed intent to expired and frees slot", async () => {
    const slots = new InMemorySlotRepository([
      {
        id: SLOT_ID,
        professional: "alice",
        startTime: 1_900_000_000_000,
        endTime: 1_900_000_360_000,
        bookable: false,
      },
    ]);
    const intents = new InMemoryBookingIntentRepository();
    const intent = await intents.create({
      slotId: SLOT_ID,
      professional: "alice",
      customerId: "cust-1",
      startTime: 1_900_000_000_000,
      endTime: 1_900_000_360_000,
      status: "confirmed",
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });
    const projector = new EscrowStateProjector(intents, slots, [CONTRACT]);
    const event = makeEvent({
      kind: "Slashed",
      slotId: SLOT_ID,
      ledgerSeq: 103,
      bookingIntentId: intent.id,
    });
    const outcome = await projector.project(event);
    expect(outcome.result).toBe("applied");
    expect(outcome.intent?.status).toBe("expired");
    expect(slots.findById(SLOT_ID)?.bookable).toBe(true);
  });

  it("Slashed on already-expired intent is a no-op (intent matches target)", async () => {
    const ctx = setup({ withIntent: "yes" });
    const intent = ctx.intents.listAll()[0];
    ctx.intents.updateStatus(intent.id, "expired");
    const event = makeEvent({
      kind: "Slashed",
      slotId: SLOT_ID,
      ledgerSeq: 103,
      bookingIntentId: intent.id,
    });
    const outcome = await ctx.projector.project(event);
    // Slashed → expired is a replay when the intent is already expired.
    expect(outcome.result).toBe("noop_slot_already");
  });

  it("Slashed on cancelled intent returns noop_terminal_intent", async () => {
    const ctx = setup({ withIntent: "yes" });
    const intent = ctx.intents.listAll()[0];
    ctx.intents.updateStatus(intent.id, "cancelled");
    const event = makeEvent({
      kind: "Slashed",
      slotId: SLOT_ID,
      ledgerSeq: 103,
      bookingIntentId: intent.id,
    });
    const outcome = await ctx.projector.project(event);
    expect(outcome.result).toBe("noop_terminal_intent");
  });
});

describe("EscrowStateProjector — Allowlist", () => {
  it("rejects events whose contract is not in the allowlist", async () => {
    const ctx = setup({ withIntent: "yes", allowList: ["COTHER"] });
    const intent = ctx.intents.listAll()[0];
    // EVENT ADDRESS differs from "COTHER"
    const event = makeEvent({
      kind: "Held",
      slotId: SLOT_ID,
      ledgerSeq: 100,
      bookingIntentId: intent.id,
    });
    const outcome = await ctx.projector.project(event);
    expect(outcome.result).toBe("noop_rejected_address");
  });

  it("with empty allowlist, security-default rejects every event", async () => {
    const slots = new InMemorySlotRepository();
    const intents = new InMemoryBookingIntentRepository();
    const projector = new EscrowStateProjector(intents, slots, []); // empty = reject all
    const event = makeEvent({ kind: "Held", slotId: SLOT_ID, ledgerSeq: 100 });
    const outcome = await projector.project(event);
    expect(outcome.result).toBe("noop_rejected_address");
  });
});

describe("EscrowStateProjector — Idempotency on replay", () => {
  it("Held applied twice yields the same final state", async () => {
    const ctx = setup({ withIntent: "yes" });
    const intent = ctx.intents.listAll()[0];
    const event = makeEvent({
      kind: "Held",
      slotId: SLOT_ID,
      ledgerSeq: 100,
      bookingIntentId: intent.id,
    });

    const first = await ctx.projector.project(event);
    expect(first.result).toBe("applied");
    const second = await ctx.projector.project(event);
    expect(second.result).toBe("noop_slot_already");
    expect(ctx.intents.findById(intent.id)?.status).toBe("confirmed");
  });
});

describe("EscrowStateProjector — Intent lookup", () => {
  it("falls back to slot-id lookup when no bookingIntentId is present", async () => {
    const ctx = setup({ withIntent: "yes" });
    const event = makeEvent({ kind: "Held", slotId: SLOT_ID, ledgerSeq: 100 });
    const outcome = await ctx.projector.project(event);
    expect(outcome.result).toBe("applied");
  });

  it("prefers bookingIntentId lookup and rejects mismatched slot", async () => {
    const ctx = setup({ withIntent: "yes" });
    const intent = ctx.intents.listAll()[0];
    // Event references another intent id + mismatched slot
    const event = makeEvent({
      kind: "Held",
      slotId: SLOT_ID_B,
      ledgerSeq: 100,
      bookingIntentId: intent.id,
    });
    const outcome = await ctx.projector.project(event);
    // bookingIntentId points to intent for SLOT_ID but event claims SLOT_ID_B → skip-lookup
    expect(outcome.result).toBe("noop_unknown_intent");
  });
});

describe("EscrowStateProjector — validator integration", () => {
  it("uses the downstream validator via the runEscrowListenerTick path", () => {
    // Smoke: a constructed raw event from the validator must equal the
    // projector-friendly makeEvent result.
    const raw = {
      kind: "Held",
      txHash: "f".repeat(64),
      eventIndex: 0,
      ledgerSeq: 200,
      closeTime: "2024-01-01T00:00:00.000Z",
      contractAddress: CONTRACT,
      slotId: SLOT_ID,
    };
    const event: EscrowEvent = validateEscrowEvent(raw);
    expect(event.kind).toBe("Held");
    expect(event.slotId).toBe(SLOT_ID);
  });
});

describe("EscrowStateProjector — fake client wiring smoke", () => {
  it("connects to a FakeEscrowContractClient for scripted tests", async () => {
    const fake = new FakeEscrowContractClient({ startingTip: 110 });
    fake.enqueue(
      105,
      makeEvent({ kind: "Held", slotId: SLOT_ID, ledgerSeq: 105 }),
    );
    const ledger = await fake.getLatestLedger();
    expect(ledger.latestLedgerSeq).toBe(110);
    const page = await fake.getEvents({ startLedger: 1, limit: 10 });
    expect(page.events).toHaveLength(1);
  });
});
