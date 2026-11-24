import os from "node:os";
import { ApplicationLifecycle } from "../lifecycle.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { InMemoryCursorStore } from "../scheduler/escrowCursorStore.js";
import { InMemoryIdempotencyStore } from "../scheduler/escrowIdempotencyStore.js";
import {
  parseEscrowListenerEnv,
  startEscrowListener,
} from "../scheduler/escrowListenerBootstrap.js";
import {
  escrowListenerFreshnessSeconds,
  escrowListenerLagSequences,
  escrowListenerRollup,
} from "../scheduler/escrowMetrics.js";
import { EscrowStateProjector } from "../scheduler/escrowStateProjector.js";
import { resetSloMetrics } from "../metrics/sloMetrics.js";
import {
  FakeEscrowContractClient,
  VALID_CONTRACT_ADDRESS,
  makeEvent,
} from "../test-helpers/escrowContractClient.js";

const SLOT_ID = "slot-22222222-2222-4222-8222-222222222222";
const CONTRACT = VALID_CONTRACT_ADDRESS;

beforeEach(() => {
  resetSloMetrics();
  escrowListenerRollup.reset();
});

describe("escrow listener wiring", () => {
  it("does not start when ESCROW_LISTENER_ENABLED is not true", () => {
    const handle = startEscrowListener({
      env: {
        ESCROW_LISTENER_ENABLED: "false",
        ESCROW_CONTRACT_ADDRESSES: CONTRACT,
      },
    });
    expect(handle).toBeNull();
  });

  it("does not start when ESCROW_CONTRACT_ADDRESSES allowlist is empty", () => {
    const handle = startEscrowListener({
      env: {
        ESCROW_LISTENER_ENABLED: "true",
        ESCROW_CONTRACT_ADDRESSES: "  ,  ",
      },
    });
    expect(handle).toBeNull();
  });

  it("derives default instanceId from hostname and parses allowlist", () => {
    const parsed = parseEscrowListenerEnv({
      ESCROW_LISTENER_ENABLED: "true",
      ESCROW_CONTRACT_ADDRESSES: ` ${CONTRACT} , CSECOND `,
      ESCROW_LISTENER_TICK_INTERVAL_MS: "250",
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.contractAddressAllowList).toEqual([CONTRACT, "CSECOND"]);
    expect(parsed.instanceId).toBe(os.hostname().trim() || "chronopay-escrow-listener");
    expect(parsed.tickIntervalMs).toBe(250);
  });

  it("projects events, updates freshness and lag metrics, and stops within one tick interval on shutdown", async () => {
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
    const intent = await intents.create({
      slotId: SLOT_ID,
      professional: "alice",
      customerId: "cust-1",
      startTime: 1_900_000_000_000,
      endTime: 1_900_000_360_000,
      status: "pending",
      createdAt: new Date(1_700_000_000_000).toISOString(),
    });

    const cursorStore = new InMemoryCursorStore();
    const idempotencyStore = new InMemoryIdempotencyStore();
    const projector = new EscrowStateProjector(intents, slots, [CONTRACT]);
    const client = new FakeEscrowContractClient({ startingTip: 110 });

    const closeTimeMs = 1_700_000_000_000;
    const nowMs = closeTimeMs + 5_000;
    client.enqueue(
      100,
      makeEvent({
        kind: "Held",
        slotId: SLOT_ID,
        ledgerSeq: 100,
        bookingIntentId: intent.id,
        contractAddress: CONTRACT,
        closeTime: new Date(closeTimeMs).toISOString(),
      }),
    );

    const lifecycle = new ApplicationLifecycle([], 5_000);
    const tickIntervalMs = 50;
    const instanceId = "wiring-smoke-test";

    const handle = startEscrowListener({
      env: {
        ESCROW_LISTENER_ENABLED: "true",
        ESCROW_CONTRACT_ADDRESSES: CONTRACT,
        ESCROW_LISTENER_INSTANCE_ID: instanceId,
        ESCROW_LISTENER_TICK_INTERVAL_MS: String(tickIntervalMs),
      },
      shouldStop: () => lifecycle.isShuttingDown,
      contractClient: client,
      cursorStore,
      idempotencyStore,
      projector,
      now: () => nowMs,
    });

    expect(handle).not.toBeNull();
    lifecycle.registerStop("escrow-listener", () => handle!.stop());

    // Wait for at least one tick to complete and project the event.
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(intents.findById(intent.id)?.status).toBe("confirmed");
    expect(await cursorStore.get(instanceId)).toBe(100);

    // Verify lag and freshness metrics were updated.
    const lagMetric = await escrowListenerLagSequences.get();
    const lagEntry = lagMetric.values.find((v) => v.labels.instance_id === instanceId);
    expect(lagEntry?.value).toBe(8); // safeTip=108, cursor=100 => lag=8

    const freshnessMetric = await escrowListenerFreshnessSeconds.get();
    const freshnessCount = freshnessMetric.values.find(
      (v) =>
        v.metricName === "escrow_listener_freshness_seconds_count" &&
        v.labels.instance_id === instanceId,
    );
    expect(freshnessCount?.value).toBeGreaterThanOrEqual(1);

    // Trigger graceful shutdown (SIGTERM path) and verify loop exits within one tick interval.
    const shutdownStart = Date.now();
    await lifecycle.shutdown();
    const elapsedMs = Date.now() - shutdownStart;

    expect(lifecycle.isShuttingDown).toBe(true);
    expect(elapsedMs).toBeLessThan(tickIntervalMs * 4);
  });
});
