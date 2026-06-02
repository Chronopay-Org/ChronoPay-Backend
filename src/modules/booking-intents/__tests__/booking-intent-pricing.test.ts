import { jest } from "@jest/globals";
import { BookingIntentService } from "../booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../booking-intent-repository.js";
import { InMemorySlotRepository } from "../../slots/slot-repository.js";
import type { SlotRecord } from "../../slots/slot-repository.js";
import { DECAY_WINDOW_MS } from "../../../services/pricingStrategy.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW_MS = 1_900_000_000_000;
const SLOT_START = NOW_MS + DECAY_WINDOW_MS; // exactly 24 h away

const BOOKABLE_SLOT: SlotRecord = {
  id: "slot-11111111-1111-4111-8111-111111111111",
  professional: "alice",
  startTime: SLOT_START,
  endTime: SLOT_START + 3_600_000,
  bookable: true,
};

const ACTOR = { userId: "customer-1", role: "customer" as const, claims: {} as any };

function makeService(slots: SlotRecord[] = [BOOKABLE_SLOT]) {
  const slotRepo = new InMemorySlotRepository(slots);
  const intentRepo = new InMemoryBookingIntentRepository();
  // Fix "now" so tests are deterministic
  const service = new BookingIntentService(intentRepo, slotRepo, () => new Date(NOW_MS).toISOString());
  // Patch Date.now inside the service's pricing block via jest.spyOn
  return { service, slotRepo, intentRepo };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BookingIntentService — pricing snapshot integration", () => {
  let dateSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    dateSpy = jest.spyOn(Date, "now").mockReturnValue(NOW_MS);
  });

  afterEach(() => {
    dateSpy.mockRestore();
  });

  describe("no pricing strategy provided", () => {
    it("creates intent without pricing fields", async () => {
      const { service } = makeService();
      const intent = await service.createIntent(
        { slotId: BOOKABLE_SLOT.id },
        ACTOR,
      );
      expect(intent.pricingStrategyId).toBeUndefined();
      expect(intent.resolvedPrice).toBeUndefined();
      expect(intent.pricingSnapshot).toBeUndefined();
    });
  });

  describe("fixed strategy", () => {
    it("snapshots strategyId, resolvedPrice, and inputs", async () => {
      const { service } = makeService();
      const intent = await service.createIntent(
        { slotId: BOOKABLE_SLOT.id, pricingStrategyId: "fixed", basePrice: 500 },
        ACTOR,
      );
      expect(intent.pricingStrategyId).toBe("fixed");
      expect(intent.resolvedPrice).toBe(500);
      expect(intent.pricingSnapshot).toMatchObject({
        basePrice: 500,
        slotStartTime: SLOT_START,
        nowMs: NOW_MS,
        activeIntentCount: 0,
      });
    });

    it("defaults basePrice to 0 when not provided", async () => {
      const { service } = makeService();
      const intent = await service.createIntent(
        { slotId: BOOKABLE_SLOT.id, pricingStrategyId: "fixed" },
        ACTOR,
      );
      expect(intent.resolvedPrice).toBe(0);
    });
  });

  describe("time_decay strategy", () => {
    it("returns full price when slot is exactly 24 h away", async () => {
      const { service } = makeService();
      const intent = await service.createIntent(
        { slotId: BOOKABLE_SLOT.id, pricingStrategyId: "time_decay", basePrice: 1000 },
        ACTOR,
      );
      expect(intent.pricingStrategyId).toBe("time_decay");
      expect(intent.resolvedPrice).toBe(1000); // full price at 24 h boundary
    });

    it("returns floor price when slot has already started", async () => {
      dateSpy.mockReturnValue(SLOT_START + 1000); // past start
      const { service } = makeService();
      const intent = await service.createIntent(
        { slotId: BOOKABLE_SLOT.id, pricingStrategyId: "time_decay", basePrice: 1000 },
        ACTOR,
      );
      expect(intent.resolvedPrice).toBe(500); // 50% floor
    });
  });

  describe("demand_based strategy", () => {
    it("returns base price when no other pending intents exist", async () => {
      const { service } = makeService();
      const intent = await service.createIntent(
        { slotId: BOOKABLE_SLOT.id, pricingStrategyId: "demand_based", basePrice: 1000 },
        ACTOR,
      );
      expect(intent.pricingStrategyId).toBe("demand_based");
      // 0 active intents at time of creation → base price
      expect(intent.resolvedPrice).toBe(1000);
      expect(intent.pricingSnapshot?.activeIntentCount).toBe(0);
    });

    it("reflects existing pending intents in the snapshot", async () => {
      // Create a second slot so we can pre-populate a pending intent
      const slot2: SlotRecord = {
        id: "slot-22222222-2222-4222-8222-222222222222",
        professional: "bob",
        startTime: SLOT_START,
        endTime: SLOT_START + 3_600_000,
        bookable: true,
      };
      const { service, intentRepo } = makeService([BOOKABLE_SLOT, slot2]);

      // Manually inject a pending intent to simulate demand
      await intentRepo.create({
        slotId: slot2.id,
        professional: "bob",
        customerId: "other-customer",
        startTime: SLOT_START,
        endTime: SLOT_START + 3_600_000,
        status: "pending",
        createdAt: new Date(NOW_MS).toISOString(),
      });

      const intent = await service.createIntent(
        { slotId: BOOKABLE_SLOT.id, pricingStrategyId: "demand_based", basePrice: 1000 },
        ACTOR,
      );
      // 1 existing pending intent → 1000 * 1.1 = 1100
      expect(intent.resolvedPrice).toBe(1100);
      expect(intent.pricingSnapshot?.activeIntentCount).toBe(1);
    });
  });

  describe("snapshot immutability", () => {
    it("snapshot is independent of subsequent state changes", async () => {
      const { service, intentRepo } = makeService();
      const intent = await service.createIntent(
        { slotId: BOOKABLE_SLOT.id, pricingStrategyId: "demand_based", basePrice: 1000 },
        ACTOR,
      );
      const snapshotAtCreation = intent.pricingSnapshot?.activeIntentCount;

      // Inject more intents after creation
      await intentRepo.create({
        slotId: "slot-99999999-9999-4999-8999-999999999999",
        professional: "dave",
        customerId: "other-2",
        startTime: SLOT_START,
        endTime: SLOT_START + 3_600_000,
        status: "pending",
        createdAt: new Date(NOW_MS).toISOString(),
      });

      // The snapshot on the already-created intent must not change
      const fetched = intentRepo.findById(intent.id);
      expect(fetched?.pricingSnapshot?.activeIntentCount).toBe(snapshotAtCreation);
    });
  });
});
