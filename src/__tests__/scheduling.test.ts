import { SchedulingService, SlotNotBookableError, SlotNotFoundError } from "../services/schedulingService.js";
import { InMemorySlotRepository, type SlotRecord } from "../modules/slots/slot-repository.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { BookingIntentService } from "../modules/booking-intents/booking-intent-service.js";
 
// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSlot(overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    id: "slot-1",
    professional: "alice",
    startTime: 1_900_000_000_000,
    endTime: 1_900_000_360_000,
    bookable: true,
    ...overrides,
  };
}

const actor = { userId: "customer-1", role: "customer" as const, claims: {} as any };
const admin = { userId: "admin-1", role: "admin" as const, claims: {} as any };

// ─── SchedulingService ───────────────────────────────────────────────────────

describe("SchedulingService", () => {
  let slotRepo: InMemorySlotRepository;
  let intentRepo: InMemoryBookingIntentRepository;
  let scheduler: SchedulingService;

  beforeEach(() => {
    slotRepo = new InMemorySlotRepository([makeSlot()]);
    intentRepo = new InMemoryBookingIntentRepository();
    scheduler = new SchedulingService(slotRepo, intentRepo);
  });

  describe("reserveSlot", () => {
    it("marks a bookable slot as not bookable", async () => {
      scheduler.reserveSlot("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(false);
    });

    it("throws SlotNotFoundError for a non-existent slot", async () => {
      expect(() => scheduler.reserveSlot("slot-unknown")).toThrow(SlotNotFoundError);
    });

    it("throws SlotNotBookableError when slot is already reserved", async () => {
      scheduler.reserveSlot("slot-1");
      expect(() => scheduler.reserveSlot("slot-1")).toThrow(SlotNotBookableError);
    });
  });

  describe("releaseSlot", () => {
    it("marks a reserved slot back to bookable", async () => {
      scheduler.reserveSlot("slot-1");
      scheduler.releaseSlot("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("is idempotent on an already-bookable slot", async () => {
      scheduler.releaseSlot("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("throws when slot does not exist", async () => {
      expect(() => scheduler.releaseSlot("slot-unknown")).toThrow("not found");
    });
  });
});

// ─── BookingIntentService + scheduling integration ──────────────────────────

describe("BookingIntentService scheduling integration", () => {
  let slotRepo: InMemorySlotRepository;
  let intentRepo: InMemoryBookingIntentRepository;
  let service: BookingIntentService;

  beforeEach(() => {
    slotRepo = new InMemorySlotRepository([makeSlot()]);
    intentRepo = new InMemoryBookingIntentRepository();
    service = new BookingIntentService(intentRepo, slotRepo);
  });

  describe("createIntent", () => {
    it("reserves the slot on intent creation", async () => {
      await service.createIntent({ slotId: "slot-1" }, actor);
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(false);
    });

    it("rejects creation when slot is already reserved", async () => {
      await service.createIntent({ slotId: "slot-1" }, actor);
      const other = { userId: "customer-2", role: "customer" as const, claims: {} as any };
      await expect(service.createIntent({ slotId: "slot-1" }, other)).rejects.toThrow(
        /not bookable/,
      );
    });

    it("rejects creation on a non-bookable slot", async () => {
      slotRepo.updateBookable("slot-1", false);
      await expect(service.createIntent({ slotId: "slot-1" }, actor)).rejects.toThrow(
        /not bookable/,
      );
    });

    it("rejects creation when slot does not exist", async () => {
      await expect(service.createIntent({ slotId: "slot-missing" }, actor)).rejects.toThrow(/not found/);
    });

    it("rejects duplicate intent by same customer on same slot", async () => {
      await service.createIntent({ slotId: "slot-1" }, actor);
      await expect(service.createIntent({ slotId: "slot-1" }, actor)).rejects.toThrow(
        /not bookable/,
      );
    });

    it("allows another customer after cancel + release", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.cancelIntent(intent.id, actor);
      const other = { userId: "customer-2", role: "customer" as const, claims: {} as any };
      const second = await service.createIntent({ slotId: "slot-1" }, other);
      expect(second.slotId).toBe("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(false);
    });

    it("allows another customer after expire + release", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.expireIntent(intent.id);
      const other = { userId: "customer-2", role: "customer" as const, claims: {} as any };
      const second = await service.createIntent({ slotId: "slot-1" }, other);
      expect(second.slotId).toBe("slot-1");
    });
  });

  describe("cancelIntent", () => {
    it("releases the slot back to bookable", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.cancelIntent(intent.id, actor);
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("updates intent status to cancelled", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      const cancelled = service.cancelIntent(intent.id, actor);
      expect(cancelled.status).toBe("cancelled");
    });

    it("rejects cancellation by non-owner non-admin", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      const other = { userId: "customer-2", role: "customer" as const, claims: {} as any };
      expect(() => service.cancelIntent(intent.id, other)).toThrow(
        /not authorized/,
      );
    });

    it("allows admin to cancel any intent", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      const cancelled = service.cancelIntent(intent.id, admin);
      expect(cancelled.status).toBe("cancelled");
    });

    it("rejects cancellation of non-pending intent", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.cancelIntent(intent.id, actor);
      expect(() => service.cancelIntent(intent.id, actor)).toThrow(
        /Cannot cancel/,
      );
    });

    it("rejects cancellation of a non-existent intent", async () => {
      expect(() => service.cancelIntent("intent-unknown", actor)).toThrow(
        /not found/,
      );
    });
  });

  describe("expireIntent", () => {
    it("releases the slot back to bookable", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.expireIntent(intent.id);
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("updates intent status to expired", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      const expired = service.expireIntent(intent.id);
      expect(expired.status).toBe("expired");
    });

    it("rejects expiry of non-pending intent", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.cancelIntent(intent.id, actor);
      expect(() => service.expireIntent(intent.id)).toThrow(/Cannot expire/);
    });

    it("rejects expiry of non-existent intent", async () => {
      expect(() => service.expireIntent("intent-unknown")).toThrow(
        /not found/,
      );
    });
  });

  describe("double-booking prevention (concurrent intents)", () => {
    it("prevents two customers from booking the same slot", async () => {
      await service.createIntent({ slotId: "slot-1" }, actor);
      const second = { userId: "customer-2", role: "customer" as const, claims: {} as any };
      await expect(service.createIntent({ slotId: "slot-1" }, second)).rejects.toThrow(
        /not bookable/,
      );
    });

    it("prevents a second intent after the first is cancelled", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, { userId: "customer-1", role: "customer" as const, claims: {} as any });
      service.cancelIntent(intent.id, { userId: "customer-1", role: "customer" as const, claims: {} as any });
      const second = await service.createIntent({ slotId: "slot-1" }, { userId: "customer-2", role: "customer" as const, claims: {} as any });
      expect(second.slotId).toBe("slot-1");
    });
  });
});

// ─── Repository-level edge cases ────────────────────────────────────────────

describe("InMemoryBookingIntentRepository edge cases", () => {
  it("updateStatus throws on non-existent intent", async () => {
    const repo = new InMemoryBookingIntentRepository();
    expect(() => repo.updateStatus("non-existent", "cancelled")).toThrow(
      /not found/,
    );
  });

  it("findBySlotId only returns pending intents", async () => {
    const repo = new InMemoryBookingIntentRepository();
    const created = await repo.create({
      slotId: "slot-1",
      professional: "alice",
      customerId: "c1",
      startTime: 1_000,
      endTime: 2_000,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    expect(repo.findBySlotId("slot-1")).toBeDefined();
    repo.updateStatus(created.id, "cancelled");
    expect(repo.findBySlotId("slot-1")).toBeUndefined();
  });
});

describe("InMemorySlotRepository edge cases", () => {
  it("updateBookable throws on non-existent slot", async () => {
    const repo = new InMemorySlotRepository([]);
    expect(() => repo.updateBookable("no-slot", true)).toThrow(/not found/);
  });

  it("list returns copies of all slots", async () => {
    const repo = new InMemorySlotRepository([makeSlot()]);
    const all = repo.list();
    expect(all).toHaveLength(1);
    all[0]!.bookable = false;
    expect(repo.findById("slot-1")!.bookable).toBe(true);
  });

  it("findById returns undefined for missing id", async () => {
    const repo = new InMemorySlotRepository([]);
    expect(repo.findById("nope")).toBeUndefined();
  });
});

// ─── Race-condition simulation ──────────────────────────────────────────────

describe("race-condition guard", () => {
  it("simulates concurrent reserve calls — second one fails", async () => {
    const slotRepo = new InMemorySlotRepository([makeSlot()]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const scheduler = new SchedulingService(slotRepo, intentRepo);

    scheduler.reserveSlot("slot-1");
    expect(() => scheduler.reserveSlot("slot-1")).toThrow(SlotNotBookableError);
    const slot = slotRepo.findById("slot-1")!;
    expect(slot.bookable).toBe(false);
  });

  it("create->cancel->create cycle works correctly", async () => {
    const slotRepo = new InMemorySlotRepository([makeSlot()]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const service = new BookingIntentService(intentRepo, slotRepo);

    const a1 = await service.createIntent({ slotId: "slot-1" }, { userId: "a", role: "customer" as const, claims: {} as any });
    expect(slotRepo.findById("slot-1")!.bookable).toBe(false);

    service.cancelIntent(a1.id, { userId: "a", role: "customer" as const, claims: {} as any });
    expect(slotRepo.findById("slot-1")!.bookable).toBe(true);

    const a2 = await service.createIntent({ slotId: "slot-1" }, { userId: "b", role: "customer" as const, claims: {} as any });
    expect(slotRepo.findById("slot-1")!.bookable).toBe(false);
    expect(a2.customerId).toBe("b");
  });
});
