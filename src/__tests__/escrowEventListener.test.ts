import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import {
  InMemoryBookingIntentRepository,
} from "../modules/booking-intents/booking-intent-repository.js";
import { EscrowStateProjector } from "../scheduler/escrowStateProjector.js";
import { runEscrowListenerTick } from "../scheduler/escrowEventListener.js";
import { InMemoryCursorStore } from "../scheduler/escrowCursorStore.js";
import { InMemoryIdempotencyStore } from "../scheduler/escrowIdempotencyStore.js";
import {
  escrowListenerRollup,
} from "../scheduler/escrowMetrics.js";
import { resetSloMetrics } from "../metrics/sloMetrics.js";
import {
  FakeEscrowContractClient,
  VALID_CONTRACT_ADDRESS,
  makeEvent,
  makeSeries,
} from "../test-helpers/escrowContractClient.js";

const SLOT_ID = "slot-11111111-1111-4111-8111-111111111111";
// Mirror the mock's computed VALID_CONTRACT_ADDRESS to guarantee byte-
// equality against the default contractAddress produced by makeEvent().
const CONTRACT = VALID_CONTRACT_ADDRESS;

interface Harness {
  client: FakeEscrowContractClient;
  cursor: InMemoryCursorStore;
  idempotency: InMemoryIdempotencyStore;
  slots: InMemorySlotRepository;
  intents: InMemoryBookingIntentRepository;
  projector: EscrowStateProjector;
}

function buildHarness(allowList: string[] = [CONTRACT], startingTip: number = 0): Harness {
  const slots = new InMemorySlotRepository([
    {
      id: SLOT_ID,
      professional: "alice",
      startTime: 1_900_000_000_000,
      endTime: 1_900_000_360_000,
      bookable: true,
    },
  ]);
  const intents = new InMemoryBookingIntentRepository();
  const cursor = new InMemoryCursorStore();
  const idempotency = new InMemoryIdempotencyStore();
  const projector = new EscrowStateProjector(intents, slots, allowList);
  const client = new FakeEscrowContractClient({ startingTip });
  return { client, cursor, idempotency, intents, slots, projector };
}

async function seedPendingIntent(
  intents: InMemoryBookingIntentRepository,
  slotId: string,
  status: "pending" | "confirmed" = "pending",
): Promise<string> {
  const rec = await intents.create({
    slotId,
    professional: "alice",
    customerId: "cust-1",
    startTime: 1_900_000_000_000,
    endTime: 1_900_000_360_000,
    status,
    createdAt: new Date(1_700_000_000_000).toISOString(),
  });
  return rec.id;
}

beforeEach(() => {
  resetSloMetrics();
  escrowListenerRollup.reset();
});

describe("runEscrowListenerTick — basic flow", () => {
  it("applies a single Held event and advances the cursor", async () => {
    const h = buildHarness();
    const intentId = await seedPendingIntent(h.intents, SLOT_ID);
    h.client.enqueue(
      100,
      makeEvent({
        kind: "Held",
        slotId: SLOT_ID,
        ledgerSeq: 100,
        bookingIntentId: intentId,
      }),
    );
    h.client.advanceTip(110);

    const result = await runEscrowListenerTick({
      instanceId: "test",
      contractClient: h.client,
      cursorStore: h.cursor,
      idempotencyStore: h.idempotency,
      projector: h.projector,
    });

    expect(result.appliedEvents).toBe(1);
    expect(result.cursorBefore).toBeNull();
    expect(result.cursorAfter).toBe(100);
    // Default finality=2, tip=110 → safeTip=108; cursor=100 → lag=8
    expect(result.lagSequences).toBe(8);
    expect(result.freshestAppliedCloseTime).not.toBeNull();
    expect(h.intents.findById(intentId)?.status).toBe("confirmed");
  });

  it("returns immediately when the cursor has caught up to the safe tip", async () => {
    const h = buildHarness();
    h.cursor.seed("test", 98);
    h.client.advanceTip(100);

    const result = await runEscrowListenerTick({
      instanceId: "test",
      contractClient: h.client,
      cursorStore: h.cursor,
      idempotencyStore: h.idempotency,
      projector: h.projector,
    });

    expect(result.fetchedEvents).toBe(0);
    expect(result.cursorAfter).toBe(98);
    expect(result.lagSequences).toBe(0);
    expect(result.appliedEvents).toBe(0);
  });
});

describe("runEscrowListenerTick — finality window", () => {
  it("skips events outside the safe window and applies them on the next tick", async () => {
    const h = buildHarness();
    const intentId = await seedPendingIntent(h.intents, SLOT_ID);
    // Use two *different* event kinds so both can fully apply (Held then
    // Released yields a real confirmation-plus-cancellation sequence).
    h.client.enqueue(
      100,
      makeEvent({
        kind: "Held",
        slotId: SLOT_ID,
        ledgerSeq: 100,
        bookingIntentId: intentId,
        txHash: "1".repeat(64),
        eventIndex: 0,
      }),
    );
    h.client.enqueue(
      101,
      makeEvent({
        kind: "Released",
        slotId: SLOT_ID,
        ledgerSeq: 101,
        bookingIntentId: intentId,
        txHash: "2".repeat(64),
        eventIndex: 0,
      }),
    );
    // Tip = 100 → safeTip = 98 → neither event is in safe window
    h.client.advanceTip(100);

    const first = await runEscrowListenerTick({
      instanceId: "test",
      contractClient: h.client,
      cursorStore: h.cursor,
      idempotencyStore: h.idempotency,
      projector: h.projector,
    });
    expect(first.appliedEvents).toBe(0);
    // Nothing observed past safeTipSeq → maxProcessedSeq stays at the seed
    // (null cursor coerces to 0). No set call. cursorAfter=0 is correct.
    expect(first.cursorAfter).toBe(0);

    // Advance the tip so both events are within safe window.
    h.client.advanceTip(105);
    const second = await runEscrowListenerTick({
      instanceId: "test",
      contractClient: h.client,
      cursorStore: h.cursor,
      idempotencyStore: h.idempotency,
      projector: h.projector,
    });
    // Held applies (pending → confirmed), then Released applies
    // (confirmed → cancelled). Both are "applied" outcomes.
    expect(second.appliedEvents).toBe(2);
    expect(second.cursorAfter).toBe(101);
  });
});

describe("runEscrowListenerTick — idempotency replay", () => {
  it("treats a re-fetched batch as duplicates and does not re-apply state", async () => {
    const h = buildHarness();
    const intentId = await seedPendingIntent(h.intents, SLOT_ID);
    const events = makeSeries({
      count: 3,
      kind: "Held",
      slotId: SLOT_ID,
      ledgerSeq: 100,
      bookingIntentId: intentId,
      ledgerStep: 1,
    });
    for (const e of events) h.client.enqueue(e.ledgerSeq, e);
    h.client.advanceTip(110);

    // First run: applies all three and advances cursor to 102.
    await runEscrowListenerTick({
      instanceId: "test",
      contractClient: h.client,
      cursorStore: h.cursor,
      idempotencyStore: h.idempotency,
      projector: h.projector,
    });
    expect(h.intents.findById(intentId)?.status).toBe("confirmed");
    expect(await h.cursor.get("test")).toBe(102);

    // Simulate restart by rewinding the cursor while keeping idempotency
    // and intents as-is — the same window is now re-fetched. Do NOT
    // re-enqueue to the script (otherwise each event would appear twice
    // and the fake client would deliver duplicates non-idempotently).
    h.cursor.seed("test", 99);

    const replay = await runEscrowListenerTick({
      instanceId: "test",
      contractClient: h.client,
      cursorStore: h.cursor,
      idempotencyStore: h.idempotency,
      projector: h.projector,
    });
    // All three events were already processed last tick, so the idempotency
    // gate short-circuits them and we observe 3 duplicates and 0 applies.
    expect(replay.duplicateIdempotencyHits).toBe(3);
    expect(replay.appliedEvents).toBe(0);
    expect(replay.cursorAfter).toBe(102);
    expect(h.intents.findById(intentId)?.status).toBe("confirmed");
  });
});

describe("runEscrowListenerTick — crash recovery via idempotency release", () => {
  it("releases the idempotency claim when the projector throws so the next tick retries", async () => {
    const h = buildHarness();
    const intentId = await seedPendingIntent(h.intents, SLOT_ID);
    const event = makeEvent({
      kind: "Held",
      slotId: SLOT_ID,
      ledgerSeq: 100,
      bookingIntentId: intentId,
    });
    h.client.enqueue(100, event);
    h.client.advanceTip(110);

    // Force the projector to throw on the first call, then recover.
    const originalProject = h.projector.project.bind(h.projector);
    let callCount = 0;
    h.projector.project = async (ev) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("simulated projector crash");
      }
      return originalProject(ev);
    };

    await expect(
      runEscrowListenerTick({
        instanceId: "test",
        contractClient: h.client,
        cursorStore: h.cursor,
        idempotencyStore: h.idempotency,
        projector: h.projector,
      }),
    ).rejects.toThrow(/simulated projector crash/);

    const key = `${event.txHash.toLowerCase()}:${event.eventIndex}`;
    expect(h.idempotency.has(key)).toBe(false);

    // Retry succeeds.
    h.projector.project = originalProject;
    const second = await runEscrowListenerTick({
      instanceId: "test",
      contractClient: h.client,
      cursorStore: h.cursor,
      idempotencyStore: h.idempotency,
      projector: h.projector,
    });
    expect(second.appliedEvents).toBe(1);
    expect(h.intents.findById(intentId)?.status).toBe("confirmed");
  });
});

describe("runEscrowListenerTick — allowlist enforcement", () => {
  it("filters out events from non-allowlisted contracts at the listener boundary", async () => {
    // Listener only accepts the "COTHER" address, but the scripted event
    // comes from the default CONTRACT (C + 55 A's). Pass contractAddressAllowList
    // explicitly so the listener hands the allow-list down to the contract
    // client as a filter; the fake client then returns 0 events.
    const allowList = ["COTHER"];
    const h = buildHarness(allowList);
    const intentId = await seedPendingIntent(h.intents, SLOT_ID);
    h.client.enqueue(
      100,
      makeEvent({
        kind: "Held",
        slotId: SLOT_ID,
        ledgerSeq: 100,
        bookingIntentId: intentId,
        contractAddress: CONTRACT,
      }),
    );
    h.client.advanceTip(110);

    const result = await runEscrowListenerTick({
      instanceId: "test",
      contractClient: h.client,
      cursorStore: h.cursor,
      idempotencyStore: h.idempotency,
      projector: h.projector,
      contractAddressAllowList: allowList,
    });
    expect(result.appliedEvents).toBe(0);
    expect(result.fetchedEvents).toBe(0);
    expect(result.cursorAfter).toBe(0);
  });
});

describe("runEscrowListenerTick — transport failures", () => {
  it("propagates getLatestLedger failures and counts them", async () => {
    const h = buildHarness();
    h.client.failNextGetLatestOnce();
    await expect(
      runEscrowListenerTick({
        instanceId: "test",
        contractClient: h.client,
        cursorStore: h.cursor,
        idempotencyStore: h.idempotency,
        projector: h.projector,
      }),
    ).rejects.toThrow(/simulated getLatestLedger/);

    const counts = escrowListenerRollup.snapshot();
    expect(counts.contractErrors).toBe(1);
  });

  it("propagates getEvents failures and counts them", async () => {
    const h = buildHarness();
    h.client.advanceTip(110);
    h.client.failNextGetEventsOnce();
    await expect(
      runEscrowListenerTick({
        instanceId: "test",
        contractClient: h.client,
        cursorStore: h.cursor,
        idempotencyStore: h.idempotency,
        projector: h.projector,
      }),
    ).rejects.toThrow(/simulated getEvents/);

    const counts = escrowListenerRollup.snapshot();
    expect(counts.contractErrors).toBe(1);
  });
});

describe("runEscrowListenerTick — freshness SLO", () => {
  it("flags the SLO violation when an applied event is older than the threshold", async () => {
    const h = buildHarness();
    const intentId = await seedPendingIntent(h.intents, SLOT_ID);
    const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    h.client.enqueue(
      100,
      makeEvent({
        kind: "Held",
        slotId: SLOT_ID,
        ledgerSeq: 100,
        bookingIntentId: intentId,
        closeTime: stale,
      }),
    );
    h.client.advanceTip(110);

    const result = await runEscrowListenerTick({
      instanceId: "test",
      contractClient: h.client,
      cursorStore: h.cursor,
      idempotencyStore: h.idempotency,
      projector: h.projector,
      freshnessSloSeconds: 60,
    });
    expect(result.freshnessSeconds ?? 0).toBeGreaterThan(60);
    expect(result.freshnessExceededSlo).toBe(true);
  });

  it("does not exceed the SLO when events are within the threshold", async () => {
    const h = buildHarness();
    const intentId = await seedPendingIntent(h.intents, SLOT_ID);
    h.client.enqueue(
      100,
      makeEvent({
        kind: "Held",
        slotId: SLOT_ID,
        ledgerSeq: 100,
        bookingIntentId: intentId,
        closeTime: new Date(Date.now() - 5_000).toISOString(),
      }),
    );
    h.client.advanceTip(110);

    const result = await runEscrowListenerTick({
      instanceId: "test",
      contractClient: h.client,
      cursorStore: h.cursor,
      idempotencyStore: h.idempotency,
      projector: h.projector,
      freshnessSloSeconds: 60,
    });
    expect(result.freshnessSeconds ?? 0).toBeLessThanOrEqual(60);
    expect(result.freshnessExceededSlo).toBe(false);
  });
});

describe("runEscrowListenerTick — slot reclaim on terminal events", () => {
  // Each kind gets a unique 64-char hex hash so the per-kind idempotency keys
  // are distinct across this describe block.
  const perKindHash: Record<"Released" | "Refunded" | "Slashed", string> = {
    Released: "2".repeat(64),
    Refunded: "3".repeat(64),
    Slashed: "4".repeat(64),
  };

  for (const kind of ["Released", "Refunded", "Slashed"] as const) {
    it(`frees the slot when a ${kind} event projects onto a confirmed intent`, async () => {
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
        customerId: `cust-${kind}`,
        startTime: 1_900_000_000_000,
        endTime: 1_900_000_360_000,
        status: "confirmed",
        createdAt: new Date(1_700_000_000_000).toISOString(),
      });
      const projector = new EscrowStateProjector(intents, slots, [CONTRACT]);
      const client = new FakeEscrowContractClient({ startingTip: 110 });
      client.enqueue(
        100,
        makeEvent({
          kind,
          slotId: SLOT_ID,
          ledgerSeq: 100,
          bookingIntentId: intent.id,
          txHash: perKindHash[kind],
          eventIndex: 0,
        }),
      );
      await runEscrowListenerTick({
        instanceId: `test-${kind}`,
        contractClient: client,
        cursorStore: new InMemoryCursorStore(),
        idempotencyStore: new InMemoryIdempotencyStore(),
        projector,
      });
      expect(slots.findById(SLOT_ID)?.bookable).toBe(true);
      const expectedStatus = kind === "Slashed" ? "expired" : "cancelled";
      expect(intents.findById(intent.id)?.status).toBe(expectedStatus);
    });
  }
});

describe("runEscrowListenerTick — lag snapshot", () => {
  it("reports lag = safeTipSeq - cursor after the tick", async () => {
    const h = buildHarness();
    h.cursor.seed("test", 105);
    h.client.advanceTip(115); // safeTip = 113

    const result = await runEscrowListenerTick({
      instanceId: "test",
      contractClient: h.client,
      cursorStore: h.cursor,
      idempotencyStore: h.idempotency,
      projector: h.projector,
    });
    expect(result.lagSequences).toBe(8); // 113 - 105
    expect(result.cursorAfter).toBe(105);
  });
});

describe("runEscrowListenerTick — validator propagation", () => {
  it("rejects a malformed event from the RPC", async () => {
    const h = buildHarness();
    h.client.advanceTip(110);
    const original = h.client.getEvents.bind(h.client);
    h.client.getEvents = async (args) => {
      const page = await original(args);
      return { ...page, events: [{ ...page.events[0], txHash: "not-hex" }] as any };
    };

    await expect(
      runEscrowListenerTick({
        instanceId: "test",
        contractClient: h.client,
        cursorStore: h.cursor,
        idempotencyStore: h.idempotency,
        projector: h.projector,
      }),
    ).rejects.toThrow();
  });
});
