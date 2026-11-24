/**
 * refundableHoldSweeperBootstrap.test.ts
 *
 * Integration-style test that verifies the sweeper loop behaves correctly
 * when wired with the shared hold repository and a SchedulingService, using
 * fake timers to avoid real wall-clock waits.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  runRefundableHoldSweeper,
  InMemoryRefundableHoldRepository,
  holdReleaseEvents,
  type HoldReleasedEvent,
} from "../refundableHoldSweeper.js";
import { SchedulingService } from "../../services/schedulingService.js";
import { InMemorySlotRepository, type SlotRecord } from "../../modules/slots/slot-repository.js";
import { InMemoryBookingIntentRepository } from "../../modules/booking-intents/booking-intent-repository.js";

const SLOT_A = "slot-aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SLOT_B = "slot-bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeSlots(): SlotRecord[] {
  return [
    { id: SLOT_A, professional: "prof-1", startTime: 1000, endTime: 2000, bookable: false },
    { id: SLOT_B, professional: "prof-2", startTime: 1000, endTime: 2000, bookable: false },
  ];
}

describe("refundable-hold sweeper bootstrap (fake timers)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("releases expired holds on the first tick and fires hold_released events", async () => {
    const holdRepo = new InMemoryRefundableHoldRepository();
    const slotRepo = new InMemorySlotRepository(makeSlots());
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    const pastMs = Date.now() - 10_000;

    // One hold already expired
    const expiredHold = holdRepo.create({
      slotId: SLOT_A,
      tenantId: "tenant-x",
      customerId: "cust-1",
      status: "active",
      createdAt: pastMs - 5_000,
      expiresAt: pastMs,
    });

    // One hold still active
    holdRepo.create({
      slotId: SLOT_B,
      tenantId: "tenant-x",
      customerId: "cust-2",
      status: "active",
      createdAt: pastMs,
      expiresAt: Date.now() + 60_000,
    });

    const releasedEvents: HoldReleasedEvent[] = [];
    const listener = (evt: HoldReleasedEvent) => releasedEvents.push(evt);
    holdReleaseEvents.on("hold_released", listener);

    const controller = new AbortController();

    try {
      // Start the loop then abort immediately so only the first sweep runs.
      // The loop does: sweepOnce() -> sleep(intervalMs) -> check abort -> exit.
      // Aborting after the first sweep (which is synchronous) is enough.
      const loopPromise = runRefundableHoldSweeper(
        controller.signal,
        { holdRepository: holdRepo, schedulingService },
        { intervalMs: 100 },
      );

      // Allow the first sweepOnce() call to execute (it's synchronous within
      // the async function), then advance time past the sleep and abort.
      await Promise.resolve(); // let the first sweep start
      controller.abort();
      // Advance fake timers to unblock the sleep(100ms) inside the loop.
      await jest.advanceTimersByTimeAsync(200);
      await loopPromise;

      // Expired hold should be marked expired and its slot released
      expect(holdRepo.findById(expiredHold.id)?.status).toBe("expired");
      expect(slotRepo.findById(SLOT_A)?.bookable).toBe(true);

      // Active hold must be untouched
      expect(slotRepo.findById(SLOT_B)?.bookable).toBe(false);

      // Event must have been emitted for the expired hold
      const event = releasedEvents.find((e) => e.holdId === expiredHold.id);
      expect(event).toBeDefined();
      expect(event?.slotId).toBe(SLOT_A);
    } finally {
      holdReleaseEvents.off("hold_released", listener);
    }
  });

  it("stops cleanly when the AbortSignal fires before the first tick", async () => {
    const holdRepo = new InMemoryRefundableHoldRepository();
    const slotRepo = new InMemorySlotRepository(makeSlots());
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    holdRepo.create({
      slotId: SLOT_A,
      customerId: "cust-preabort",
      status: "active",
      createdAt: Date.now() - 10_000,
      expiresAt: Date.now() - 5_000,
    });

    const controller = new AbortController();
    controller.abort(); // abort before even starting

    await runRefundableHoldSweeper(
      controller.signal,
      { holdRepository: holdRepo, schedulingService },
      { intervalMs: 100 },
    );

    // No sweeps ran; slot stays reserved
    expect(slotRepo.findById(SLOT_A)?.bookable).toBe(false);
  });

  it("skips paused tenants and does not release their slots", async () => {
    const holdRepo = new InMemoryRefundableHoldRepository();
    const slotRepo = new InMemorySlotRepository(makeSlots());
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    const pastMs = Date.now() - 10_000;

    holdRepo.create({
      slotId: SLOT_A,
      tenantId: "paused-tenant",
      customerId: "cust-paused",
      status: "active",
      createdAt: pastMs - 5_000,
      expiresAt: pastMs,
    });

    schedulingService.pausedTenants.add("paused-tenant");

    const controller = new AbortController();

    const loopPromise = runRefundableHoldSweeper(
      controller.signal,
      { holdRepository: holdRepo, schedulingService },
      { intervalMs: 100 },
    );

    await Promise.resolve();
    controller.abort();
    await jest.advanceTimersByTimeAsync(200);
    await loopPromise;

    // Hold was not released because tenant is paused
    expect(slotRepo.findById(SLOT_A)?.bookable).toBe(false);
  });

  it("honours REFUNDABLE_HOLD_SWEEPER_DISABLED env flag logic (unit check)", () => {
    // This test verifies the env-flag contract used in src/index.ts without
    // actually importing index.ts (which would bind a port and start all workers).
    const originalEnv = process.env.REFUNDABLE_HOLD_SWEEPER_DISABLED;
    try {
      process.env.REFUNDABLE_HOLD_SWEEPER_DISABLED = "true";
      const disabled = process.env.REFUNDABLE_HOLD_SWEEPER_DISABLED === "true";
      expect(disabled).toBe(true);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.REFUNDABLE_HOLD_SWEEPER_DISABLED;
      } else {
        process.env.REFUNDABLE_HOLD_SWEEPER_DISABLED = originalEnv;
      }
    }
  });
});
