/**
 * slot-bundle-expiry.test.ts
 *
 * Tests for the slot bundle expiry feature (Issue #497).
 *
 * Covers:
 *  - SlotExpiredError: typed error class
 *  - SchedulingService: reserveSlot rejects when validUntil has passed
 *  - BookingIntentService: createIntent rejects after bundle expiry with BUNDLE_EXPIRED code
 *  - SlotService: validUntil validation on create and update
 *  - BundleExpiryService: reminder scheduling, expiry detection
 *  - Edge cases: exact expiry, refund of unused slots, admin extension
 */

import {
  SchedulingService,
  SlotExpiredError,
  SlotNotFoundError,
  SlotNotBookableError,
} from "../schedulingService.js";
import {
  InMemorySlotRepository,
  type SlotRecord,
} from "../../modules/slots/slot-repository.js";
import {
  InMemoryBookingIntentRepository,
} from "../../modules/booking-intents/booking-intent-repository.js";
import { BookingIntentService, BookingIntentError } from "../../modules/booking-intents/booking-intent-service.js";
import { SlotService, SlotValidationError } from "../slotService.js";
import { BundleExpiryService } from "../bundleExpiryService.js";
import { InMemoryReminderRepository } from "../../models/reminder.js";
import { ERROR_CODES } from "../../errors/errorCodes.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW_MS = Date.now();
const T1 = NOW_MS + 1_000_000;
const T2 = T1 + 3_600_000;
const T3 = T2 + 3_600_000;
const VALID_UNTIL = T3 + 3_600_000;

function makeSlot(overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    id: "slot-11111111-1111-4111-8111-111111111111",
    professional: "alice",
    startTime: T1,
    endTime: T2,
    bookable: true,
    ...overrides,
  };
}

function makeSlotRepo(slots: SlotRecord[]): InMemorySlotRepository {
  return new InMemorySlotRepository(slots.map((s) => ({ ...s })));
}

// ─── SlotExpiredError ─────────────────────────────────────────────────────────

describe("SlotExpiredError", () => {
  it("has the correct name and properties", () => {
    const err = new SlotExpiredError("slot-abc", VALID_UNTIL);
    expect(err.name).toBe("SlotExpiredError");
    expect(err.slotId).toBe("slot-abc");
    expect(err.validUntil).toBe(VALID_UNTIL);
    expect(err.message).toContain("slot-abc");
    expect(err.message).toContain(new Date(VALID_UNTIL).toISOString());
  });

  it("is an instance of Error", () => {
    const err = new SlotExpiredError("slot-abc", VALID_UNTIL);
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── SchedulingService.reserveSlot ────────────────────────────────────────────

describe("SchedulingService.reserveSlot with validUntil", () => {
  function makeScheduling(slots: SlotRecord[]) {
    const slotRepo = makeSlotRepo(slots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const scheduling = new SchedulingService(slotRepo, intentRepo);
    return { slotRepo, intentRepo, scheduling };
  }

  it("reserves a slot without validUntil", () => {
    const slot = makeSlot({ validUntil: undefined });
    const { scheduling, slotRepo } = makeScheduling([slot]);
    scheduling.reserveSlot(slot.id);
    expect(slotRepo.findById(slot.id)?.bookable).toBe(false);
  });

  it("reserves a slot when current time is before validUntil", () => {
    const slot = makeSlot({ validUntil: VALID_UNTIL });
    const { scheduling, slotRepo } = makeScheduling([slot]);
    scheduling.reserveSlot(slot.id, NOW_MS);
    expect(slotRepo.findById(slot.id)?.bookable).toBe(false);
  });

  it("throws SlotExpiredError when current time equals validUntil (exact expiry)", () => {
    const slot = makeSlot({ validUntil: VALID_UNTIL });
    const { scheduling, slotRepo } = makeScheduling([slot]);
    expect(() => scheduling.reserveSlot(slot.id, VALID_UNTIL)).toThrow(SlotExpiredError);
    expect(slotRepo.findById(slot.id)?.bookable).toBe(true);
  });

  it("throws SlotExpiredError when current time exceeds validUntil", () => {
    const slot = makeSlot({ validUntil: VALID_UNTIL });
    const { scheduling, slotRepo } = makeScheduling([slot]);
    expect(() => scheduling.reserveSlot(slot.id, VALID_UNTIL + 1)).toThrow(SlotExpiredError);
    expect(slotRepo.findById(slot.id)?.bookable).toBe(true);
  });

  it("throws SlotNotFoundError for unknown slot", () => {
    const { scheduling } = makeScheduling([]);
    expect(() => scheduling.reserveSlot("nonexistent")).toThrow(SlotNotFoundError);
  });

  it("throws SlotNotBookableError when slot is already reserved", () => {
    const slot = makeSlot({ bookable: false });
    const { scheduling } = makeScheduling([slot]);
    expect(() => scheduling.reserveSlot(slot.id)).toThrow(SlotNotBookableError);
  });
});

// ─── BookingIntentService.createIntent with validUntil ────────────────────────

describe("BookingIntentService.createIntent with bundle expiry", () => {
  const actor = { userId: "customer1", role: "customer" as const };

  function makeService(nowMs: number) {
    const slotRepo = makeSlotRepo([]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const service = new BookingIntentService(
      intentRepo,
      slotRepo,
      () => new Date(nowMs).toISOString(),
      () => nowMs,
    );
    return { service, slotRepo, intentRepo };
  }

  function addSlot(slotRepo: InMemorySlotRepository, slot: SlotRecord) {
    const _all = slotRepo.list();
    (slotRepo as any).slots.push({ ...slot });
  }

  it("creates an intent when validUntil is in the future", async () => {
    const slot = makeSlot({ validUntil: VALID_UNTIL });
    const { service, slotRepo } = makeService(NOW_MS);
    addSlot(slotRepo, slot);

    const intent = await service.createIntent({ slotId: slot.id }, actor);
    expect(intent.status).toBe("pending");
    expect(intent.slotId).toBe(slot.id);
  });

  it("creates an intent when validUntil is not set (no bundle)", async () => {
    const slot = makeSlot({ validUntil: undefined });
    const { service, slotRepo } = makeService(NOW_MS);
    addSlot(slotRepo, slot);

    const intent = await service.createIntent({ slotId: slot.id }, actor);
    expect(intent.status).toBe("pending");
  });

  it("throws BookingIntentError with BUNDLE_EXPIRED code after expiry", async () => {
    const slot = makeSlot({ validUntil: VALID_UNTIL });
    const { service, slotRepo } = makeService(VALID_UNTIL);
    addSlot(slotRepo, slot);

    try {
      await service.createIntent({ slotId: slot.id }, actor);
      fail("Expected BookingIntentError");
    } catch (err) {
      expect(err).toBeInstanceOf(BookingIntentError);
      expect((err as BookingIntentError).code).toBe(ERROR_CODES.BUNDLE_EXPIRED.code);
      expect((err as BookingIntentError).statusCode).toBe(422);
      expect((err as BookingIntentError).message).toContain("expired");
    }
  });

  it("throws at exact validUntil boundary (>= semantics)", async () => {
    const slot = makeSlot({ validUntil: VALID_UNTIL });
    const { service, slotRepo } = makeService(VALID_UNTIL);
    addSlot(slotRepo, slot);

    try {
      await service.createIntent({ slotId: slot.id }, actor);
      fail("Expected BookingIntentError");
    } catch (err) {
      expect(err).toBeInstanceOf(BookingIntentError);
      expect((err as BookingIntentError).code).toBe(ERROR_CODES.BUNDLE_EXPIRED.code);
    }
  });
});

// ─── SlotService validUntil validation ────────────────────────────────────────

describe("SlotService validUntil validation", () => {
  let service: SlotService;

  beforeEach(() => {
    service = new SlotService(() => new Date(NOW_MS));
  });

  describe("createSlot", () => {
    it("creates a slot with validUntil after endTime", () => {
      const slot = service.createSlot({
        professional: "alice",
        startTime: T1,
        endTime: T2,
        validUntil: VALID_UNTIL,
      });
      expect(slot.validUntil).toBe(VALID_UNTIL);
    });

    it("creates a slot without validUntil", () => {
      const slot = service.createSlot({
        professional: "alice",
        startTime: T1,
        endTime: T2,
      });
      expect(slot.validUntil).toBeUndefined();
    });

    it("throws SlotValidationError when validUntil <= endTime", () => {
      expect(() =>
        service.createSlot({
          professional: "alice",
          startTime: T1,
          endTime: T2,
          validUntil: T2,
        }),
      ).toThrow(SlotValidationError);

      expect(() =>
        service.createSlot({
          professional: "alice",
          startTime: T1,
          endTime: T2,
          validUntil: T2 - 1,
        }),
      ).toThrow(SlotValidationError);
    });

    it("throws SlotValidationError for non-finite validUntil", () => {
      expect(() =>
        service.createSlot({
          professional: "alice",
          startTime: T1,
          endTime: T2,
          validUntil: NaN,
        }),
      ).toThrow(SlotValidationError);

      expect(() =>
        service.createSlot({
          professional: "alice",
          startTime: T1,
          endTime: T2,
          validUntil: Infinity,
        }),
      ).toThrow(SlotValidationError);
    });
  });

  describe("updateSlot", () => {
    it("updates validUntil on existing slot", () => {
      const slot = service.createSlot({
        professional: "alice",
        startTime: T1,
        endTime: T2,
      });
      const updated = service.updateSlot(slot.id, { validUntil: VALID_UNTIL });
      expect(updated.validUntil).toBe(VALID_UNTIL);
    });

    it("throws when updating validUntil to a value <= endTime", () => {
      const slot = service.createSlot({
        professional: "alice",
        startTime: T1,
        endTime: T2,
      });
      expect(() =>
        service.updateSlot(slot.id, { validUntil: T2 }),
      ).toThrow(SlotValidationError);
    });

    it("throws SlotValidationError for non-finite validUntil on update", () => {
      const slot = service.createSlot({
        professional: "alice",
        startTime: T1,
        endTime: T2,
      });
      expect(() =>
        service.updateSlot(slot.id, { validUntil: NaN }),
      ).toThrow(SlotValidationError);
    });
  });
});

// ─── BundleExpiryService ──────────────────────────────────────────────────────

describe("BundleExpiryService", () => {
  describe("isExpired", () => {
    function makeExpiryService() {
      return new BundleExpiryService(
        makeSlotRepo([]),
        new InMemoryReminderRepository(),
      );
    }

    it("returns false when no validUntil is set", () => {
      const service = makeExpiryService();
      const slot = makeSlot();
      expect(service.isExpired(slot)).toBe(false);
    });

    it("returns false when now is before validUntil", () => {
      const service = makeExpiryService();
      const slot = makeSlot({ validUntil: VALID_UNTIL });
      expect(service.isExpired(slot, NOW_MS)).toBe(false);
    });

    it("returns true when now equals validUntil (exact expiry)", () => {
      const service = makeExpiryService();
      const slot = makeSlot({ validUntil: VALID_UNTIL });
      expect(service.isExpired(slot, VALID_UNTIL)).toBe(true);
    });

    it("returns true when now exceeds validUntil", () => {
      const service = makeExpiryService();
      const slot = makeSlot({ validUntil: VALID_UNTIL });
      expect(service.isExpired(slot, VALID_UNTIL + 1)).toBe(true);
    });
  });

  describe("scheduleExpiryReminder", () => {
    it("schedules a reminder for a slot with validUntil", async () => {
      const slot = makeSlot({ validUntil: VALID_UNTIL });
      const slotRepo = makeSlotRepo([slot]);
      const reminderRepo = new InMemoryReminderRepository();
      const service = new BundleExpiryService(slotRepo, reminderRepo);

      await service.scheduleExpiryReminder({ slotId: slot.id });
      const reminders = await reminderRepo.getDueReminders(VALID_UNTIL);
      expect(reminders.length).toBeGreaterThanOrEqual(1);
    });

    it("throws for slot without validUntil", async () => {
      const slot = makeSlot({ validUntil: undefined });
      const slotRepo = makeSlotRepo([slot]);
      const reminderRepo = new InMemoryReminderRepository();
      const service = new BundleExpiryService(slotRepo, reminderRepo);

      await expect(
        service.scheduleExpiryReminder({ slotId: slot.id }),
      ).rejects.toThrow("has no validUntil");
    });

    it("throws for nonexistent slot", async () => {
      const slotRepo = makeSlotRepo([]);
      const reminderRepo = new InMemoryReminderRepository();
      const service = new BundleExpiryService(slotRepo, reminderRepo);

      await expect(
        service.scheduleExpiryReminder({ slotId: "nonexistent" }),
      ).rejects.toThrow("not found");
    });

    it("uses custom lead time when provided", async () => {
      const customLead = 30 * 60 * 1000; // 30 minutes
      const slot = makeSlot({ validUntil: VALID_UNTIL });
      const slotRepo = makeSlotRepo([slot]);
      const reminderRepo = new InMemoryReminderRepository();
      const service = new BundleExpiryService(slotRepo, reminderRepo);

      await service.scheduleExpiryReminder({
        slotId: slot.id,
        leadTimeMs: customLead,
      });
      const allReminders = await reminderRepo.getDueReminders(VALID_UNTIL);
      const customReminder = allReminders.find(
        (r) => r.triggerAt === VALID_UNTIL - customLead,
      );
      expect(customReminder).toBeDefined();
    });

    it("skips scheduling when reminder trigger time would already be in the past", async () => {
      const slot = makeSlot({ validUntil: NOW_MS + 100 });
      const slotRepo = makeSlotRepo([slot]);
      const reminderRepo = new InMemoryReminderRepository();
      const service = new BundleExpiryService(slotRepo, reminderRepo);

      await service.scheduleExpiryReminder({ slotId: slot.id });
      const reminders = await reminderRepo.getDueReminders(NOW_MS + 200);
      expect(reminders.length).toBe(0);
    });
  });
});

// ─── Refund of unused slots after expiry ──────────────────────────────────────

describe("Slot release after bundle expiry (unused slots)", () => {
  it("slot is freed when intent is cancelled after expiry", () => {
    const slot = makeSlot({ validUntil: VALID_UNTIL, bookable: false });
    const slotRepo = makeSlotRepo([slot]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const scheduling = new SchedulingService(slotRepo, intentRepo);

    scheduling.releaseSlot(slot.id);
    expect(slotRepo.findById(slot.id)?.bookable).toBe(true);
  });

  it("expired slot cannot be re-reserved", () => {
    const slot = makeSlot({ validUntil: VALID_UNTIL });
    const slotRepo = makeSlotRepo([slot]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const scheduling = new SchedulingService(slotRepo, intentRepo);

    expect(() => scheduling.reserveSlot(slot.id, VALID_UNTIL)).toThrow(SlotExpiredError);
    expect(slotRepo.findById(slot.id)?.bookable).toBe(true);
  });
});

// ─── Admin extension of validUntil ────────────────────────────────────────────

describe("Admin extension of validUntil", () => {
  it("extends validUntil on a slot to allow re-booking", () => {
    const service = new SlotService(() => new Date(NOW_MS));
    const slot = service.createSlot({
      professional: "alice",
      startTime: T1,
      endTime: T2,
      validUntil: VALID_UNTIL,
    });

    const newValidUntil = VALID_UNTIL + 7 * 24 * 60 * 60 * 1000;
    const updated = service.updateSlot(slot.id, { validUntil: newValidUntil });
    expect(updated.validUntil).toBe(newValidUntil);
  });

  it("admin can extend a previously expired slot's validUntil and re-reserve", () => {
    const slot = makeSlot({ validUntil: NOW_MS - 1_000_000 });
    const slotRepo = makeSlotRepo([slot]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const scheduling = new SchedulingService(slotRepo, intentRepo);

    expect(() => scheduling.reserveSlot(slot.id, NOW_MS)).toThrow(SlotExpiredError);
    expect(slotRepo.findById(slot.id)?.bookable).toBe(true);

    // Admin extends validUntil — access internal array since findById returns copies
    const internalSlots = (slotRepo as any).slots as SlotRecord[];
    const target = internalSlots.find((s: SlotRecord) => s.id === slot.id)!;
    target.validUntil = VALID_UNTIL;

    scheduling.reserveSlot(slot.id, NOW_MS);
    expect(slotRepo.findById(slot.id)?.bookable).toBe(false);
  });
});
