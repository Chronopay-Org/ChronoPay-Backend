import {
  SchedulingService,
  ImpossibleRescheduleError,
  InvalidRescheduleRequestError,
  TenantPausedError,
  sagaEvents,
  type MultiLegBooking,
  type RescheduleOptions,
} from "../schedulingService.js";
import { InMemorySlotRepository, type SlotRecord } from "../../modules/slots/slot-repository.js";
import { InMemoryBookingIntentRepository } from "../../modules/booking-intents/booking-intent-repository.js";

function makeSlot(overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    id: "slot-1",
    professional: "pro-1",
    startTime: 1_900_000_000_000,
    endTime: 1_900_000_360_000,
    bookable: true,
    ...overrides,
  };
}

describe("Multi-Leg Booking Reschedule Engine", () => {
  let slotRepo: InMemorySlotRepository;
  let intentRepo: InMemoryBookingIntentRepository;
  let scheduler: SchedulingService;

  const BASE_TIME = 1_900_000_000_000;
  const ONE_HOUR = 3_600_000;
  const TWO_HOURS = 7_200_000;

  beforeEach(() => {
    // Set up existing slots for a 2-leg booking (Leg 0 at BASE_TIME, Leg 1 at BASE_TIME + 2 hours)
    // and candidate slots at target times (BASE_TIME + 24 hours, BASE_TIME + 48 hours)
    slotRepo = new InMemorySlotRepository([
      // Current slots held by multi-leg booking
      makeSlot({ id: "leg0-curr-slot", professional: "pro-1", startTime: BASE_TIME, endTime: BASE_TIME + ONE_HOUR, bookable: false }),
      makeSlot({ id: "leg1-curr-slot", professional: "pro-2", startTime: BASE_TIME + TWO_HOURS, endTime: BASE_TIME + TWO_HOURS + ONE_HOUR, bookable: false }),

      // Candidate Target Option 1: BASE_TIME + 24h (Leg 0: BASE + 24h, Leg 1: BASE + 26h)
      makeSlot({ id: "leg0-cand1-slot", professional: "pro-1", startTime: BASE_TIME + 24 * ONE_HOUR, endTime: BASE_TIME + 25 * ONE_HOUR, bookable: true }),
      makeSlot({ id: "leg1-cand1-slot", professional: "pro-2", startTime: BASE_TIME + 26 * ONE_HOUR, endTime: BASE_TIME + 27 * ONE_HOUR, bookable: true }),

      // Candidate Target Option 2: BASE_TIME + 48h (Leg 0: BASE + 48h, Leg 1: BASE + 50h)
      makeSlot({ id: "leg0-cand2-slot", professional: "pro-1", startTime: BASE_TIME + 48 * ONE_HOUR, endTime: BASE_TIME + 49 * ONE_HOUR, bookable: true }),
      makeSlot({ id: "leg1-cand2-slot", professional: "pro-2", startTime: BASE_TIME + 50 * ONE_HOUR, endTime: BASE_TIME + 51 * ONE_HOUR, bookable: true }),
    ]);

    intentRepo = new InMemoryBookingIntentRepository();
    scheduler = new SchedulingService(slotRepo, intentRepo);
    sagaEvents.removeAllListeners();
  });

  const sampleBooking: MultiLegBooking = {
    bookingId: "booking-123",
    buyerId: "buyer-456",
    tenantId: "tenant-789",
    legs: [
      {
        legId: "leg-0",
        slotId: "leg0-curr-slot",
        professional: "pro-1",
        startTime: BASE_TIME,
        endTime: BASE_TIME + ONE_HOUR,
      },
      {
        legId: "leg-1",
        slotId: "leg1-curr-slot",
        professional: "pro-2",
        startTime: BASE_TIME + TWO_HOURS,
        endTime: BASE_TIME + TWO_HOURS + ONE_HOUR,
        offsetMs: TWO_HOURS,
      },
    ],
  };

  describe("planMultiLegReschedule", () => {
    it("computes candidate windows preserving relative offsets intact by default", () => {
      const options: RescheduleOptions = {
        bookingId: "booking-123",
        buyerId: "buyer-456",
        targetAnchorStartTimeMs: BASE_TIME + 24 * ONE_HOUR,
      };

      const candidates = scheduler.planMultiLegReschedule(sampleBooking, options);

      expect(candidates.length).toBeGreaterThan(0);
      const primaryOption = candidates[0];
      expect(primaryOption.legs).toHaveLength(2);

      const leg0 = primaryOption.legs.find((l) => l.legId === "leg-0")!;
      const leg1 = primaryOption.legs.find((l) => l.legId === "leg-1")!;

      expect(leg0.newStartTime).toBe(BASE_TIME + 24 * ONE_HOUR);
      expect(leg0.newSlotId).toBe("leg0-cand1-slot");

      // Leg 1 offset preserved at +2 hours relative to Leg 0
      expect(leg1.newStartTime).toBe(BASE_TIME + 26 * ONE_HOUR);
      expect(leg1.newSlotId).toBe("leg1-cand1-slot");
      expect(leg1.offsetMs).toBe(TWO_HOURS);
      expect(leg1.isOverridden).toBe(false);
    });

    it("presents N options ordered by fewest disruptions (lowest disruptionScore first)", () => {
      const options: RescheduleOptions = {
        bookingId: "booking-123",
        buyerId: "buyer-456",
        searchWindow: {
          startMs: BASE_TIME + 24 * ONE_HOUR,
          endMs: BASE_TIME + 48 * ONE_HOUR,
        },
        searchStepMs: 24 * ONE_HOUR,
        maxOptions: 2,
      };

      const candidates = scheduler.planMultiLegReschedule(sampleBooking, options);

      expect(candidates.length).toBeLessThanOrEqual(2);
      expect(candidates[0].disruptionScore).toBeLessThanOrEqual(candidates[1]?.disruptionScore ?? Infinity);
    });

    it("supports per-leg offset overrides", () => {
      // Override Leg 1 to have an offset of +3 hours instead of +2 hours
      const newLeg1Start = BASE_TIME + 24 * ONE_HOUR + 3 * ONE_HOUR; // BASE + 27h
      slotRepo = new InMemorySlotRepository([
        makeSlot({ id: "leg0-curr-slot", professional: "pro-1", startTime: BASE_TIME, endTime: BASE_TIME + ONE_HOUR, bookable: false }),
        makeSlot({ id: "leg1-curr-slot", professional: "pro-2", startTime: BASE_TIME + TWO_HOURS, endTime: BASE_TIME + TWO_HOURS + ONE_HOUR, bookable: false }),
        makeSlot({ id: "leg0-cand1-slot", professional: "pro-1", startTime: BASE_TIME + 24 * ONE_HOUR, endTime: BASE_TIME + 25 * ONE_HOUR, bookable: true }),
        makeSlot({ id: "leg1-override-slot", professional: "pro-2", startTime: newLeg1Start, endTime: newLeg1Start + ONE_HOUR, bookable: true }),
      ]);
      scheduler = new SchedulingService(slotRepo, intentRepo);

      const options: RescheduleOptions = {
        bookingId: "booking-123",
        buyerId: "buyer-456",
        targetAnchorStartTimeMs: BASE_TIME + 24 * ONE_HOUR,
        legOverrides: {
          "leg-1": {
            legId: "leg-1",
            offsetOverrideMs: 3 * ONE_HOUR,
          },
        },
      };

      const candidates = scheduler.planMultiLegReschedule(sampleBooking, options);

      expect(candidates.length).toBeGreaterThan(0);
      const leg1 = candidates[0].legs.find((l) => l.legId === "leg-1")!;
      expect(leg1.newStartTime).toBe(newLeg1Start);
      expect(leg1.newSlotId).toBe("leg1-override-slot");
      expect(leg1.offsetMs).toBe(3 * ONE_HOUR);
      expect(leg1.isOverridden).toBe(true);
    });

    it("supports partial reschedule (keeping specific leg pinned to original time)", () => {
      // Keep Leg 1 fixed at original slot/time, move Leg 0 to BASE + 24h
      const options: RescheduleOptions = {
        bookingId: "booking-123",
        buyerId: "buyer-456",
        targetAnchorStartTimeMs: BASE_TIME + 24 * ONE_HOUR,
        legOverrides: {
          "leg-1": {
            legId: "leg-1",
            skipReschedule: true,
          },
        },
      };

      const candidates = scheduler.planMultiLegReschedule(sampleBooking, options);

      expect(candidates.length).toBeGreaterThan(0);
      const leg0 = candidates[0].legs.find((l) => l.legId === "leg-0")!;
      const leg1 = candidates[0].legs.find((l) => l.legId === "leg-1")!;

      expect(leg0.newStartTime).toBe(BASE_TIME + 24 * ONE_HOUR);
      expect(leg1.newStartTime).toBe(sampleBooking.legs[1].startTime);
      expect(leg1.newSlotId).toBe(sampleBooking.legs[1].slotId);
      expect(leg1.isPartialKept).toBe(true);
    });

    it("throws ImpossibleRescheduleError when no available slots satisfy leg offsets", () => {
      // Empty slot repository so no candidate slots exist
      slotRepo = new InMemorySlotRepository([]);
      scheduler = new SchedulingService(slotRepo, intentRepo);

      const options: RescheduleOptions = {
        bookingId: "booking-123",
        buyerId: "buyer-456",
        targetAnchorStartTimeMs: BASE_TIME + 24 * ONE_HOUR,
      };

      expect(() => scheduler.planMultiLegReschedule(sampleBooking, options)).toThrow(
        ImpossibleRescheduleError,
      );
    });

    it("throws TenantPausedError when tenant is paused", () => {
      scheduler.setTenantPaused("tenant-789", true);

      const options: RescheduleOptions = {
        bookingId: "booking-123",
        buyerId: "buyer-456",
        targetAnchorStartTimeMs: BASE_TIME + 24 * ONE_HOUR,
      };

      expect(() => scheduler.planMultiLegReschedule(sampleBooking, options)).toThrow(
        TenantPausedError,
      );
    });

    it("throws InvalidRescheduleRequestError when buyer is unauthorized", () => {
      const options: RescheduleOptions = {
        bookingId: "booking-123",
        buyerId: "unauthorized-buyer",
        targetAnchorStartTimeMs: BASE_TIME + 24 * ONE_HOUR,
      };

      expect(() => scheduler.planMultiLegReschedule(sampleBooking, options)).toThrow(
        InvalidRescheduleRequestError,
      );
    });
  });

  describe("confirmMultiLegReschedule", () => {
    it("releases old slots, reserves new candidate slots, and triggers saga re-execution", () => {
      const options: RescheduleOptions = {
        bookingId: "booking-123",
        buyerId: "buyer-456",
        targetAnchorStartTimeMs: BASE_TIME + 24 * ONE_HOUR,
      };

      const candidates = scheduler.planMultiLegReschedule(sampleBooking, options);
      const chosenOption = candidates[0];

      let sagaPayload: any = null;
      sagaEvents.on("saga.reexecute", (payload) => {
        sagaPayload = payload;
      });

      const result = scheduler.confirmMultiLegReschedule({
        bookingId: sampleBooking.bookingId,
        buyerId: sampleBooking.buyerId,
        optionId: chosenOption.optionId,
        candidateOption: chosenOption,
        multiLegBooking: sampleBooking,
      });

      expect(result.status).toBe("reexecuted");
      expect(result.sagaExecutionId).toMatch(/^saga_[0-9a-f-]+$/);

      // Verify old slots released and new slots reserved
      expect(slotRepo.findById("leg0-curr-slot")!.bookable).toBe(true);
      expect(slotRepo.findById("leg1-curr-slot")!.bookable).toBe(true);
      expect(slotRepo.findById("leg0-cand1-slot")!.bookable).toBe(false);
      expect(slotRepo.findById("leg1-cand1-slot")!.bookable).toBe(false);

      // Verify saga re-execution event was emitted
      expect(sagaPayload).not.toBeNull();
      expect(sagaPayload.bookingId).toBe(sampleBooking.bookingId);
      expect(sagaPayload.sagaExecutionId).toBe(result.sagaExecutionId);
    });

    it("rejects confirmation if buyer is unauthorized", () => {
      const options: RescheduleOptions = {
        bookingId: "booking-123",
        buyerId: "buyer-456",
        targetAnchorStartTimeMs: BASE_TIME + 24 * ONE_HOUR,
      };

      const candidates = scheduler.planMultiLegReschedule(sampleBooking, options);

      expect(() =>
        scheduler.confirmMultiLegReschedule({
          bookingId: sampleBooking.bookingId,
          buyerId: "imposter-buyer",
          optionId: candidates[0].optionId,
          candidateOption: candidates[0],
          multiLegBooking: sampleBooking,
        }),
      ).toThrow(InvalidRescheduleRequestError);
    });

    it("rejects confirmation if tenant is paused", () => {
      const options: RescheduleOptions = {
        bookingId: "booking-123",
        buyerId: "buyer-456",
        targetAnchorStartTimeMs: BASE_TIME + 24 * ONE_HOUR,
      };

      const candidates = scheduler.planMultiLegReschedule(sampleBooking, options);
      scheduler.setTenantPaused("tenant-789", true);

      expect(() =>
        scheduler.confirmMultiLegReschedule({
          bookingId: sampleBooking.bookingId,
          buyerId: sampleBooking.buyerId,
          optionId: candidates[0].optionId,
          candidateOption: candidates[0],
          multiLegBooking: sampleBooking,
        }),
      ).toThrow(TenantPausedError);
    });
  });
});
