import { jest } from "@jest/globals";
import { BookingIntentService, BookingIntentError } from "../booking-intent-service.js";
import { InMemoryBookingIntentRepository, type BookingIntentRecord } from "../booking-intent-repository.js";
import { InMemorySlotRepository, type SlotRecord } from "../../slots/slot-repository.js";
import { defaultAuditLogger } from "../../../services/auditLogger.js";

describe("BookingIntentService - refund security & guards", () => {
  let repo: InMemoryBookingIntentRepository;
  let slotRepo: InMemorySlotRepository;
  let service: BookingIntentService;
  let currentMockNowMs: number;
  let auditSpy: ReturnType<typeof jest.spyOn>;

  const customerActor = {
    userId: "cust-123",
    role: "customer" as const,
    claims: {} as any,
  };

  const otherCustomerActor = {
    userId: "cust-999",
    role: "customer" as const,
    claims: {} as any,
  };

  const adminActor = {
    userId: "admin-456",
    role: "admin" as const,
    claims: {} as any,
  };

  const baseSlot: SlotRecord = {
    id: "slot-1",
    professional: "prof-1",
    startTime: 10_000,
    endTime: 20_000,
    bookable: false,
  };

  const baselineSlot: SlotRecord = {
    id: "slot-baseline",
    professional: "prof-1",
    startTime: 10_000,
    endTime: 20_000,
    bookable: false,
  };

  const createBaseIntent = (overrides: Partial<BookingIntentRecord> = {}): Omit<BookingIntentRecord, "id"> => ({
    slotId: "slot-1",
    professional: "prof-1",
    customerId: "cust-123",
    startTime: 10_000,
    endTime: 20_000,
    status: "confirmed",
    createdAt: new Date().toISOString(),
    pricingSnapshot: {
      strategyId: "fixed",
      resolvedPrice: 10_000, // 100.00 USD / 10,000 cents
      basePrice: 10_000,
      slotStartMs: 10_000,
      nowMs: 0,
      activeBookings: 1,
      capacity: 1,
      config: {},
    },
    ...overrides,
  });

  beforeEach(() => {
    repo = new InMemoryBookingIntentRepository();
    slotRepo = new InMemorySlotRepository([baseSlot, baselineSlot]);
    currentMockNowMs = 15_000; // Halfway through the 10_000..20_000 slot

    auditSpy = jest.spyOn(defaultAuditLogger, "log").mockResolvedValue(undefined as any);

    service = new BookingIntentService(
      repo,
      slotRepo,
      () => new Date(currentMockNowMs).toISOString(),
      () => currentMockNowMs,
    );
  });

  afterEach(() => {
    auditSpy.mockRestore();
  });

  describe("Customer backdating prevention", () => {
    it("customer refund with cancelledAtMs earlier than startTime returns the same amount as without it (server clock)", async () => {
      // Slot: 10_000 -> 20_000 (total: 10_000 ms)
      // Server clock: 15_000 ms (50% consumed, so 50% refund = 5_000 cents)
      const intent = await repo.create(createBaseIntent());

      // 1. Refund without cancelledAtMs: uses server clock (15_000 ms)
      // We calculate expected via a separate intent
      const baseIntentRecord = await repo.create(createBaseIntent({ slotId: "slot-baseline" }));
      const baselineResult = service.refundIntent(baseIntentRecord.id, customerActor);
      expect(baselineResult.refundAmountCents).toBe(5_000);
      expect(baselineResult.refundRatio).toBeCloseTo(0.5, 5);

      // 2. Customer provides backdated cancelledAtMs (e.g. 5_000, before slot startTime 10_000)
      const result = service.refundIntent(intent.id, customerActor, {
        cancelledAtMs: 5_000,
      });

      // Customer's cancelledAtMs MUST be ignored, yielding the exact same refund as baseline
      expect(result.refundAmountCents).toBe(baselineResult.refundAmountCents);
      expect(result.refundRatio).toBe(baselineResult.refundRatio);
      expect(result.consumedRatio).toBe(baselineResult.consumedRatio);

      // Verify audit log was NOT called for customer refund
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("regression test: backdated refund does not yield full 100% refund when service is fully consumed", async () => {
      // Slot ran from 10_000 -> 20_000.
      // Current server time is 25_000 (slot has ended, 100% consumed).
      currentMockNowMs = 25_000;
      service = new BookingIntentService(
        repo,
        slotRepo,
        () => new Date(currentMockNowMs).toISOString(),
        () => currentMockNowMs,
      );

      const intent = await repo.create(createBaseIntent());

      // Malicious customer sends cancelledAtMs = 5_000 (before slot start).
      // On main, this yielded a 100% full refund (10_000 cents) because consumedMs was clamped to 0.
      const result = service.refundIntent(intent.id, customerActor, {
        cancelledAtMs: 5_000,
      });

      // With security fix, server clock (25_000) is used, so consumed is 100% and refund is 0 cents.
      expect(result.refundAmountCents).toBe(0);
      expect(result.refundAmountCents).not.toBe(10_000);
      expect(result.consumedRatio).toBe(1);
      expect(result.refundRatio).toBe(0);
    });
  });

  describe("Admin override and audit logging", () => {
    it("admin override with cancelledAtMs <= nowMs applies override timestamp and logs audit record", async () => {
      // Server clock is 25_000.
      currentMockNowMs = 25_000;
      service = new BookingIntentService(
        repo,
        slotRepo,
        () => new Date(currentMockNowMs).toISOString(),
        () => currentMockNowMs,
      );

      const intent = await repo.create(createBaseIntent());

      // Admin provides backdated timestamp = 12_000 (2_000 ms into 10_000 ms duration => 80% remaining)
      const result = service.refundIntent(intent.id, adminActor, {
        cancelledAtMs: 12_000,
        reason: "admin_dispute_adjustment",
      });

      expect(result.refundAmountCents).toBe(8_000);
      expect(result.refundRatio).toBeCloseTo(0.8, 5);

      // Verify audit log was emitted
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking_intent.admin_override_cancelled_at",
          status: "success",
          resource: `booking_intent:${intent.id}`,
          metadata: expect.objectContaining({
            bookingIntentId: intent.id,
            adminUserId: adminActor.userId,
            overrideCancelledAtMs: 12_000,
            serverNowMs: 25_000,
          }),
        }),
      );
    });

    it("admin override rejects cancelledAtMs in the future with 400", async () => {
      currentMockNowMs = 15_000;
      const intent = await repo.create(createBaseIntent());

      expect(() =>
        service.refundIntent(intent.id, adminActor, {
          cancelledAtMs: 16_000, // Future relative to currentMockNowMs (15_000)
        }),
      ).toThrow(new BookingIntentError(400, "Admin override cancelledAtMs cannot be in the future."));
    });

    it("admin override rejects non-finite cancelledAtMs with 400", async () => {
      const intent = await repo.create(createBaseIntent());

      expect(() =>
        service.refundIntent(intent.id, adminActor, {
          cancelledAtMs: NaN,
        }),
      ).toThrow(new BookingIntentError(400, "cancelledAtMs must be a valid number."));
    });
  });

  describe("Status guards and double-refund prevention", () => {
    it("refunding a no_show intent throws 409", async () => {
      const intent = await repo.create(createBaseIntent({ status: "no_show" }));

      expect(() => service.refundIntent(intent.id, customerActor)).toThrow(
        new BookingIntentError(409, 'Cannot refund intent with status "no_show".'),
      );
    });

    it("refunding an intent with existing refundMetadata throws 409", async () => {
      const intent = await repo.create(
        createBaseIntent({
          refundMetadata: {
            refundedAt: new Date().toISOString(),
            refundedAmountCents: 5_000,
            refundReason: "previous_refund",
          },
        }),
      );

      expect(() => service.refundIntent(intent.id, customerActor)).toThrow(
        new BookingIntentError(409, "Intent has already been refunded."),
      );
    });

    it("refunding an intent with existing refundedAt throws 409", async () => {
      const intent = await repo.create(
        createBaseIntent({
          refundedAt: new Date().toISOString(),
        }),
      );

      expect(() => service.refundIntent(intent.id, customerActor)).toThrow(
        new BookingIntentError(409, "Intent has already been refunded."),
      );
    });

    it("a second refund attempt on the same intent returns 409", async () => {
      const intent = await repo.create(createBaseIntent());

      // First refund succeeds
      const firstResult = service.refundIntent(intent.id, customerActor);
      expect(firstResult.refundAmountCents).toBe(5_000);

      // Second refund attempt fails with 409
      expect(() => service.refundIntent(intent.id, customerActor)).toThrow(
        new BookingIntentError(409, "Intent has already been refunded."),
      );
    });
  });

  describe("Authorization & validation guards", () => {
    it("rejects unauthorized customer with 403", async () => {
      const intent = await repo.create(createBaseIntent());

      expect(() => service.refundIntent(intent.id, otherCustomerActor)).toThrow(
        new BookingIntentError(403, "You are not authorized to refund this booking intent."),
      );
    });

    it("throws 404 for non-existent intent", async () => {
      expect(() => service.refundIntent("non-existent-id", customerActor)).toThrow(
        new BookingIntentError(404, "Booking intent not found."),
      );
    });
  });
});
