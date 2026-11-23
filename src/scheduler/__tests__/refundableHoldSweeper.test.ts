import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  sweepRefundableHoldExpiryOnce,
  runRefundableHoldSweeper,
  InMemoryRefundableHoldRepository,
  holdReleaseEvents,
  HoldReleasedEvent,
  onHoldReleasedDefaultHandler,
} from "../refundableHoldSweeper.js";
import { SchedulingService } from "../../services/schedulingService.js";
import { InMemorySlotRepository, SlotRecord } from "../../modules/slots/slot-repository.js";
import { InMemoryBookingIntentRepository } from "../../modules/booking-intents/booking-intent-repository.js";

const SLOT_1 = "slot-11111111-1111-4111-8111-111111111111";
const SLOT_2 = "slot-22222222-2222-4222-8222-222222222222";
const SLOT_3 = "slot-33333333-3333-4333-8333-333333333333";

describe("RefundableHoldSweeper", () => {
  let holdRepo: InMemoryRefundableHoldRepository;
  let initialSlots: SlotRecord[];

  beforeEach(() => {
    initialSlots = [
      {
        id: SLOT_1,
        professional: "prof-1",
        startTime: 1000,
        endTime: 2000,
        bookable: false, // reserved by hold
        tenantId: "tenant-a",
      },
      {
        id: SLOT_2,
        professional: "prof-2",
        startTime: 1000,
        endTime: 2000,
        bookable: false, // reserved by hold
        tenantId: "tenant-b",
      },
      {
        id: SLOT_3,
        professional: "prof-3",
        startTime: 1000,
        endTime: 2000,
        bookable: false, // reserved by hold
        tenantId: "tenant-a",
      },
    ];
    holdRepo = new InMemoryRefundableHoldRepository();
  });

  it("scans and releases expired refundable holds, updating slot bookable state", async () => {
    const slotRepo = new InMemorySlotRepository(initialSlots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    const now = 1_000_000;
    const expiredHold = holdRepo.create({
      slotId: SLOT_1,
      tenantId: "tenant-a",
      customerId: "cust-1",
      status: "active",
      createdAt: now - 5000,
      expiresAt: now - 1000,
    });

    const activeHold = holdRepo.create({
      slotId: SLOT_2,
      tenantId: "tenant-b",
      customerId: "cust-2",
      status: "active",
      createdAt: now - 1000,
      expiresAt: now + 5000, // Not expired
    });

    const eventsEmitted: HoldReleasedEvent[] = [];
    const listener = (evt: HoldReleasedEvent) => eventsEmitted.push(evt);
    holdReleaseEvents.on("hold_released", listener);

    try {
      const result = await sweepRefundableHoldExpiryOnce(
        { holdRepository: holdRepo, schedulingService },
        { batchSize: 10 },
        now,
      );

      expect(result.releasedCount).toBe(1);
      expect(result.candidatesCount).toBe(1);

      // Verify hold status updated
      const updatedHold = holdRepo.findById(expiredHold.id);
      expect(updatedHold?.status).toBe("expired");
      expect(updatedHold?.releasedAt).toBe(now);

      // Verify unexpired hold left intact
      const untouchedHold = holdRepo.findById(activeHold.id);
      expect(untouchedHold?.status).toBe("active");

      // Verify slot capacity released back to bookable
      const slot1 = slotRepo.findById(SLOT_1);
      expect(slot1?.bookable).toBe(true);

      const slot2 = slotRepo.findById(SLOT_2);
      expect(slot2?.bookable).toBe(false);

      // Verify release event emitted for search cache
      expect(eventsEmitted).toHaveLength(1);
      expect(eventsEmitted[0].holdId).toBe(expiredHold.id);
      expect(eventsEmitted[0].slotId).toBe(SLOT_1);
    } finally {
      holdReleaseEvents.off("hold_released", listener);
    }
  });

  it("handles holds without tenantId (default tenant label)", async () => {
    const slotRepo = new InMemorySlotRepository(initialSlots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    const now = 1_000_000;
    const expiredHoldNoTenant = holdRepo.create({
      slotId: SLOT_1,
      customerId: "cust-notenant",
      status: "active",
      createdAt: now - 5000,
      expiresAt: now - 1000,
    });

    const result = await sweepRefundableHoldExpiryOnce(
      { holdRepository: holdRepo, schedulingService },
      {},
      now,
    );

    expect(result.releasedCount).toBe(1);
    const updated = holdRepo.findById(expiredHoldNoTenant.id);
    expect(updated?.status).toBe("expired");
  });

  it("uses default Date.now() when nowMs parameter is omitted", async () => {
    const slotRepo = new InMemorySlotRepository(initialSlots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    const pastExpires = Date.now() - 10000;
    holdRepo.create({
      slotId: SLOT_1,
      customerId: "cust-datenow",
      status: "active",
      createdAt: pastExpires - 5000,
      expiresAt: pastExpires,
    });

    const result = await sweepRefundableHoldExpiryOnce({ holdRepository: holdRepo, schedulingService });
    expect(result.releasedCount).toBe(1);
  });

  it("respects maxPerTenantPerBatch during fair scheduling", async () => {
    const now = 1_000_000;
    const slots: SlotRecord[] = [];

    // Tenant A has 3 expired holds
    for (let i = 1; i <= 3; i++) {
      const slotId = `slot-ta-${i}`;
      slots.push({
        id: slotId,
        professional: `prof-a-${i}`,
        startTime: 1000,
        endTime: 2000,
        bookable: false,
        tenantId: "tenant-a",
      });
      holdRepo.create({
        slotId,
        tenantId: "tenant-a",
        customerId: `cust-a-${i}`,
        status: "active",
        createdAt: now - 5000,
        expiresAt: now - 1000,
      });
    }

    const slotRepo = new InMemorySlotRepository(slots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    // Limit to max 1 per tenant per batch
    const result = await sweepRefundableHoldExpiryOnce(
      { holdRepository: holdRepo, schedulingService },
      { batchSize: 10, maxPerTenantPerBatch: 1 },
      now,
    );

    expect(result.releasedCount).toBe(1);
  });

  it("handles releaseSlot throwing an error gracefully", async () => {
    const slotRepo = new InMemorySlotRepository(initialSlots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    // Mock releaseSlot to throw
    jest.spyOn(schedulingService, "releaseSlot").mockImplementation(() => {
      throw new Error("Simulated release failure");
    });

    const now = 1_000_000;
    holdRepo.create({
      slotId: SLOT_1,
      tenantId: "tenant-a",
      customerId: "cust-err",
      status: "active",
      createdAt: now - 5000,
      expiresAt: now - 1000,
    });

    const result = await sweepRefundableHoldExpiryOnce(
      { holdRepository: holdRepo, schedulingService },
      {},
      now,
    );

    // Should still proceed and update hold status
    expect(result.releasedCount).toBe(1);
  });

  it("executes default search cache invalidation handler cleanly", async () => {
    const evt: HoldReleasedEvent = {
      holdId: "h-1",
      slotId: SLOT_1,
      tenantId: "tenant-a",
      releasedAt: Date.now(),
    };
    await expect(onHoldReleasedDefaultHandler(evt)).resolves.toBeUndefined();
  });

  it("InMemoryRefundableHoldRepository helper methods & edge cases", () => {
    const repo = new InMemoryRefundableHoldRepository();
    const created = repo.create({
      slotId: SLOT_1,
      customerId: "cust-1",
      status: "active",
      createdAt: 100,
      expiresAt: 200,
    });

    expect(repo.findById(created.id)).toEqual(created);
    expect(repo.findById("non-existent")).toBeUndefined();

    const released = repo.updateStatus(created.id, "released", 300);
    expect(released.status).toBe("released");
    expect(released.releasedAt).toBe(300);

    const confirmed = repo.updateStatus(created.id, "confirmed", 400);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedAt).toBe(400);

    expect(() => repo.updateStatus("invalid-id", "expired")).toThrow(
      'RefundableHold with id "invalid-id" not found',
    );
  });

  it("respects batchSize limits during heavy backlog", async () => {
    const now = 1_000_000;
    const slots: SlotRecord[] = [];

    for (let i = 1; i <= 5; i++) {
      const slotId = `slot-batch-${i}`;
      slots.push({
        id: slotId,
        professional: `prof-${i}`,
        startTime: 1000,
        endTime: 2000,
        bookable: false,
        tenantId: "tenant-a",
      });
      holdRepo.create({
        slotId,
        tenantId: "tenant-a",
        customerId: `cust-${i}`,
        status: "active",
        createdAt: now - 5000,
        expiresAt: now - 1000,
      });
    }

    const slotRepo = new InMemorySlotRepository(slots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    const result = await sweepRefundableHoldExpiryOnce(
      { holdRepository: holdRepo, schedulingService },
      { batchSize: 2 },
      now,
    );

    expect(result.releasedCount).toBe(2);
    expect(result.candidatesCount).toBe(5);

    const expiredCount = holdRepo.listAll().filter((h) => h.status === "expired").length;
    expect(expiredCount).toBe(2);
  });

  it("applies fair scheduling round-robin across tenants", async () => {
    const now = 1_000_000;
    const slots: SlotRecord[] = [];

    // Tenant A has 4 expired holds
    for (let i = 1; i <= 4; i++) {
      const slotId = `slot-ta-${i}`;
      slots.push({
        id: slotId,
        professional: `prof-a-${i}`,
        startTime: 1000,
        endTime: 2000,
        bookable: false,
        tenantId: "tenant-a",
      });
      holdRepo.create({
        slotId,
        tenantId: "tenant-a",
        customerId: `cust-a-${i}`,
        status: "active",
        createdAt: now - 5000,
        expiresAt: now - 1000,
      });
    }

    // Tenant B has 1 expired hold
    const slotIdB = "slot-tb-1";
    slots.push({
      id: slotIdB,
      professional: "prof-b-1",
      startTime: 1000,
      endTime: 2000,
      bookable: false,
      tenantId: "tenant-b",
    });
    const holdB = holdRepo.create({
      slotId: slotIdB,
      tenantId: "tenant-b",
      customerId: "cust-b-1",
      status: "active",
      createdAt: now - 5000,
      expiresAt: now - 1000,
    });

    const slotRepo = new InMemorySlotRepository(slots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    // Batch size 2 should pick 1 from Tenant A and 1 from Tenant B (fair scheduling)
    const result = await sweepRefundableHoldExpiryOnce(
      { holdRepository: holdRepo, schedulingService },
      { batchSize: 2 },
      now,
    );

    expect(result.releasedCount).toBe(2);

    const releasedHoldB = holdRepo.findById(holdB.id);
    expect(releasedHoldB?.status).toBe("expired");

    const releasedTenantA = holdRepo.listAll().filter((h) => h.tenantId === "tenant-a" && h.status === "expired");
    expect(releasedTenantA).toHaveLength(1);
  });

  it("handles race condition with buyer confirm (skips hold if confirmed concurrently)", async () => {
    const slotRepo = new InMemorySlotRepository(initialSlots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    const now = 1_000_000;
    const hold = holdRepo.create({
      slotId: SLOT_1,
      tenantId: "tenant-a",
      customerId: "cust-1",
      status: "active",
      createdAt: now - 5000,
      expiresAt: now - 1000,
    });

    // Simulate buyer confirming payment right before sweep processes it
    holdRepo.updateStatus(hold.id, "confirmed");

    const result = await sweepRefundableHoldExpiryOnce(
      { holdRepository: holdRepo, schedulingService },
      { batchSize: 10 },
      now,
    );

    expect(result.releasedCount).toBe(0);
    const confirmedHold = holdRepo.findById(hold.id);
    expect(confirmedHold?.status).toBe("confirmed");
    expect(slotRepo.findById(SLOT_1)?.bookable).toBe(false);
  });

  it("skips processing holds for paused tenants", async () => {
    const slotRepo = new InMemorySlotRepository(initialSlots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    const now = 1_000_000;
    holdRepo.create({
      slotId: SLOT_1,
      tenantId: "tenant-paused",
      customerId: "cust-1",
      status: "active",
      createdAt: now - 5000,
      expiresAt: now - 1000,
    });

    schedulingService.pausedTenants.add("tenant-paused");

    const result = await sweepRefundableHoldExpiryOnce(
      { holdRepository: holdRepo, schedulingService },
      { batchSize: 10 },
      now,
    );

    expect(result.releasedCount).toBe(0);
    expect(result.skippedBecausePaused).toBe(1);
    expect(slotRepo.findById(SLOT_1)?.bookable).toBe(false);
  });

  it("triggers safety brake when candidates exceed safetyThreshold", async () => {
    const now = 1_000_000;
    const slots: SlotRecord[] = [];

    for (let i = 1; i <= 5; i++) {
      const slotId = `slot-thresh-${i}`;
      slots.push({
        id: slotId,
        professional: `prof-${i}`,
        startTime: 1000,
        endTime: 2000,
        bookable: false,
        tenantId: "tenant-a",
      });
      holdRepo.create({
        slotId,
        tenantId: "tenant-a",
        customerId: `cust-${i}`,
        status: "active",
        createdAt: now - 5000,
        expiresAt: now - 1000,
      });
    }

    const slotRepo = new InMemorySlotRepository(slots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    const result = await sweepRefundableHoldExpiryOnce(
      { holdRepository: holdRepo, schedulingService },
      { safetyThreshold: 3 }, // Threshold is 3, candidate count is 5
      now,
    );

    expect(result.skippedBecauseThreshold).toBe(true);
    expect(result.releasedCount).toBe(0);
    expect(result.candidatesCount).toBe(5);
  });

  it("runs background worker loop, performs sweeps, and stops cleanly on abort", async () => {
    const slotRepo = new InMemorySlotRepository(initialSlots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    const abortController = new AbortController();

    const now = 1_000_000;
    holdRepo.create({
      slotId: SLOT_1,
      tenantId: "tenant-a",
      customerId: "cust-loop",
      status: "active",
      createdAt: now - 5000,
      expiresAt: now - 1000,
    });

    const sweepPromise = runRefundableHoldSweeper(
      abortController.signal,
      { holdRepository: holdRepo, schedulingService },
      { intervalMs: 20 },
    );

    // Wait short time for at least 1 sweep execution
    await new Promise((resolve) => setTimeout(resolve, 50));
    abortController.abort();
    await sweepPromise;

    const expired = holdRepo.listAll().filter((h) => h.status === "expired");
    expect(expired).toHaveLength(1);
  });

  it("stops worker loop immediately if aborted before first iteration", async () => {
    const slotRepo = new InMemorySlotRepository(initialSlots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const schedulingService = new SchedulingService(slotRepo, intentRepo);

    const abortController = new AbortController();
    abortController.abort();

    await runRefundableHoldSweeper(
      abortController.signal,
      { holdRepository: holdRepo, schedulingService },
      { intervalMs: 100 },
    );
  });
});
