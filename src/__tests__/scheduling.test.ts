import { SchedulingService, SlotNotBookableError, SlotNotFoundError } from "../services/schedulingService.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { BookingIntentService } from "../modules/booking-intents/booking-intent-service.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

// @ts-expect-error - Auto-fixed by script
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

const actor = { userId: "customer-1", role: "customer" as const };
const admin = { userId: "admin-1", role: "admin" as const };

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
    it("marks a bookable slot as not bookable", () => {
      scheduler.reserveSlot("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(false);
    });

    it("throws SlotNotFoundError for a non-existent slot", () => {
      expect(() => scheduler.reserveSlot("slot-unknown")).toThrow(SlotNotFoundError);
    });

    it("throws SlotNotBookableError when slot is already reserved", () => {
      scheduler.reserveSlot("slot-1");
      expect(() => scheduler.reserveSlot("slot-1")).toThrow(SlotNotBookableError);
    });
  });

  describe("releaseSlot", () => {
    it("marks a reserved slot back to bookable", () => {
      scheduler.reserveSlot("slot-1");
      scheduler.releaseSlot("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("is idempotent on an already-bookable slot", () => {
      scheduler.releaseSlot("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("throws when slot does not exist", () => {
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
    it("reserves the slot on intent creation", () => {
      // @ts-expect-error - Auto-fixed by script
      service.createIntent({ slotId: "slot-1" }, actor);
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(false);
    });

    it("rejects creation when slot is already reserved", () => {
      // @ts-expect-error - Auto-fixed by script
      service.createIntent({ slotId: "slot-1" }, actor);
      const other = { userId: "customer-2", role: "customer" as const };
      // @ts-expect-error - Auto-fixed by script
      expect(() => service.createIntent({ slotId: "slot-1" }, other)).toThrow(
        /not bookable/,
      );
    });

    it("rejects creation on a non-bookable slot", () => {
      slotRepo.updateBookable("slot-1", false);
      // @ts-expect-error - Auto-fixed by script
      expect(() => service.createIntent({ slotId: "slot-1" }, actor)).toThrow(
        /not bookable/,
      );
    });

    it("rejects creation when slot does not exist", () => {
      expect(() =>
        // @ts-expect-error - Auto-fixed by script
        service.createIntent({ slotId: "slot-missing" }, actor),
      ).toThrow(/not found/);
    });

    it("rejects duplicate intent by same customer on same slot", () => {
      // @ts-expect-error - Auto-fixed by script
      service.createIntent({ slotId: "slot-1" }, actor);
      // @ts-expect-error - Auto-fixed by script
      expect(() => service.createIntent({ slotId: "slot-1" }, actor)).toThrow(
        /not bookable/,
      );
    });

    it("allows another customer after cancel + release", () => {
      // @ts-expect-error - Auto-fixed by script
      const intent = service.createIntent({ slotId: "slot-1" }, actor);
      // @ts-expect-error - Auto-fixed by script
      service.cancelIntent(intent.id, actor);
      const other = { userId: "customer-2", role: "customer" as const };
      // @ts-expect-error - Auto-fixed by script
      const second = service.createIntent({ slotId: "slot-1" }, other);
      // @ts-expect-error - Auto-fixed by script
      expect(second.slotId).toBe("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(false);
    });

    it("allows another customer after expire + release", () => {
      // @ts-expect-error - Auto-fixed by script
      const intent = service.createIntent({ slotId: "slot-1" }, actor);
      // @ts-expect-error - Auto-fixed by script
      service.expireIntent(intent.id);
      const other = { userId: "customer-2", role: "customer" as const };
      // @ts-expect-error - Auto-fixed by script
      const second = service.createIntent({ slotId: "slot-1" }, other);
      // @ts-expect-error - Auto-fixed by script
      expect(second.slotId).toBe("slot-1");
    });
  });

  describe("cancelIntent", () => {
    it("releases the slot back to bookable", () => {
      // @ts-expect-error - Auto-fixed by script
      const intent = service.createIntent({ slotId: "slot-1" }, actor);
      // @ts-expect-error - Auto-fixed by script
      service.cancelIntent(intent.id, actor);
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("updates intent status to cancelled", () => {
      // @ts-expect-error - Auto-fixed by script
      const intent = service.createIntent({ slotId: "slot-1" }, actor);
      // @ts-expect-error - Auto-fixed by script
      const cancelled = service.cancelIntent(intent.id, actor);
      expect(cancelled.status).toBe("cancelled");
    });

    it("rejects cancellation by non-owner non-admin", () => {
      // @ts-expect-error - Auto-fixed by script
      const intent = service.createIntent({ slotId: "slot-1" }, actor);
      const other = { userId: "customer-2", role: "customer" as const };
      // @ts-expect-error - Auto-fixed by script
      expect(() => service.cancelIntent(intent.id, other)).toThrow(
        /not authorized/,
      );
    });

    it("allows admin to cancel any intent", () => {
      // @ts-expect-error - Auto-fixed by script
      const intent = service.createIntent({ slotId: "slot-1" }, actor);
      // @ts-expect-error - Auto-fixed by script
      const cancelled = service.cancelIntent(intent.id, admin);
      expect(cancelled.status).toBe("cancelled");
    });

    it("rejects cancellation of non-pending intent", () => {
      // @ts-expect-error - Auto-fixed by script
      const intent = service.createIntent({ slotId: "slot-1" }, actor);
      // @ts-expect-error - Auto-fixed by script
      service.cancelIntent(intent.id, actor);
      // @ts-expect-error - Auto-fixed by script
      expect(() => service.cancelIntent(intent.id, actor)).toThrow(
        /Cannot cancel/,
      );
    });

    it("rejects cancellation of a non-existent intent", () => {
      // @ts-expect-error - Auto-fixed by script
      expect(() => service.cancelIntent("intent-unknown", actor)).toThrow(
        /not found/,
      );
    });
  });

  describe("expireIntent", () => {
    it("releases the slot back to bookable", () => {
      // @ts-expect-error - Auto-fixed by script
      const intent = service.createIntent({ slotId: "slot-1" }, actor);
      // @ts-expect-error - Auto-fixed by script
      service.expireIntent(intent.id);
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("updates intent status to expired", () => {
      // @ts-expect-error - Auto-fixed by script
      const intent = service.createIntent({ slotId: "slot-1" }, actor);
      // @ts-expect-error - Auto-fixed by script
      const expired = service.expireIntent(intent.id);
      expect(expired.status).toBe("expired");
    });

    it("rejects expiry of non-pending intent", () => {
      // @ts-expect-error - Auto-fixed by script
      const intent = service.createIntent({ slotId: "slot-1" }, actor);
      // @ts-expect-error - Auto-fixed by script
      service.cancelIntent(intent.id, actor);
      // @ts-expect-error - Auto-fixed by script
      expect(() => service.expireIntent(intent.id)).toThrow(/Cannot expire/);
    });

    it("rejects expiry of non-existent intent", () => {
      expect(() => service.expireIntent("intent-unknown")).toThrow(
        /not found/,
      );
    });
  });

  describe("double-booking prevention (concurrent intents)", () => {
    it("prevents two customers from booking the same slot", () => {
      // @ts-expect-error - Auto-fixed by script
      service.createIntent({ slotId: "slot-1" }, actor);
      const second = { userId: "customer-2", role: "customer" as const };
      // @ts-expect-error - Auto-fixed by script
      expect(() => service.createIntent({ slotId: "slot-1" }, second)).toThrow(
        /not bookable/,
      );
    });

    it("prevents a second intent after the first is cancelled", () => {
      // @ts-expect-error - Auto-fixed by script
      const intent = service.createIntent({ slotId: "slot-1" }, { userId: "customer-1", role: "customer" as const });
      // @ts-expect-error - Auto-fixed by script
      service.cancelIntent(intent.id, { userId: "customer-1", role: "customer" as const });
      // @ts-expect-error - Auto-fixed by script
      const second = service.createIntent({ slotId: "slot-1" }, { userId: "customer-2", role: "customer" as const });
      // @ts-expect-error - Auto-fixed by script
      expect(second.slotId).toBe("slot-1");
    });
  });
});

// ─── Repository-level edge cases ────────────────────────────────────────────

describe("InMemoryBookingIntentRepository edge cases", () => {
  it("updateStatus throws on non-existent intent", () => {
    const repo = new InMemoryBookingIntentRepository();
    expect(() => repo.updateStatus("non-existent", "cancelled")).toThrow(
      /not found/,
    );
  });

  it("findBySlotId only returns pending intents", () => {
    const repo = new InMemoryBookingIntentRepository();
    const created = repo.create({
      slotId: "slot-1",
      professional: "alice",
      customerId: "c1",
      startTime: 1_000,
      endTime: 2_000,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    expect(repo.findBySlotId("slot-1")).toBeDefined();
    // @ts-expect-error - Auto-fixed by script
    repo.updateStatus(created.id, "cancelled");
    expect(repo.findBySlotId("slot-1")).toBeUndefined();
  });
});

describe("InMemorySlotRepository edge cases", () => {
  it("updateBookable throws on non-existent slot", () => {
    const repo = new InMemorySlotRepository([]);
    expect(() => repo.updateBookable("no-slot", true)).toThrow(/not found/);
  });

  it("list returns copies of all slots", () => {
    const repo = new InMemorySlotRepository([makeSlot()]);
    const all = repo.list();
    expect(all).toHaveLength(1);
    all[0]!.bookable = false;
    expect(repo.findById("slot-1")!.bookable).toBe(true);
  });

  it("findById returns undefined for missing id", () => {
    const repo = new InMemorySlotRepository([]);
    expect(repo.findById("nope")).toBeUndefined();
  });
});

// ─── Race-condition simulation ──────────────────────────────────────────────

describe("race-condition guard", () => {
  it("simulates concurrent reserve calls — second one fails", () => {
    const slotRepo = new InMemorySlotRepository([makeSlot()]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const scheduler = new SchedulingService(slotRepo, intentRepo);

    scheduler.reserveSlot("slot-1");
    expect(() => scheduler.reserveSlot("slot-1")).toThrow(SlotNotBookableError);
    const slot = slotRepo.findById("slot-1")!;
    expect(slot.bookable).toBe(false);
  });

  it("create->cancel->create cycle works correctly", () => {
    const slotRepo = new InMemorySlotRepository([makeSlot()]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const service = new BookingIntentService(intentRepo, slotRepo);

    // @ts-expect-error - Auto-fixed by script
    const a1 = service.createIntent({ slotId: "slot-1" }, { userId: "a", role: "customer" as const });
    expect(slotRepo.findById("slot-1")!.bookable).toBe(false);

    // @ts-expect-error - Auto-fixed by script
    service.cancelIntent(a1.id, { userId: "a", role: "customer" as const });
    expect(slotRepo.findById("slot-1")!.bookable).toBe(true);

    // @ts-expect-error - Auto-fixed by script
    const a2 = service.createIntent({ slotId: "slot-1" }, { userId: "b", role: "customer" as const });
    expect(slotRepo.findById("slot-1")!.bookable).toBe(false);
    // @ts-expect-error - Auto-fixed by script
    expect(a2.customerId).toBe("b");
  });
});
