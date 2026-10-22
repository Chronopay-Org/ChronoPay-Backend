import {
  BookingIntentService,
  BookingIntentError,
} from "../booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../booking-intent-repository.js";
import {
  InMemorySlotRepository,
  type SlotRecord,
} from "../../slots/slot-repository.js";
import type { AuthContext } from "../../../middleware/auth.js";
import type { VerifiedJwtPayload } from "../../../utils/jwt.js";

const dummyClaims = {} as VerifiedJwtPayload;

const NOW_MS = 1_900_000_000_000;
const HOLD_DURATION_MS = 30 * 60 * 1000;
const BASE_PRICE_CENTS = 5000;

const PRICED_SLOT: SlotRecord = {
  id: "slot-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  professional: "alice",
  startTime: NOW_MS + 3_600_000,
  endTime: NOW_MS + 7_200_000,
  bookable: true,
  pricingStrategy: {
    strategyId: "fixed",
    basePrice: BASE_PRICE_CENTS,
    config: { strategy: "fixed" },
  },
};

const customer: AuthContext = {
  userId: "cust-1",
  role: "customer",
  claims: dummyClaims,
};

function createFixture() {
  const slotRepo = new InMemorySlotRepository([PRICED_SLOT]);
  const intentRepo = new InMemoryBookingIntentRepository();

  // Mutable clock so tests can advance time between calls.
  const clock = { nowMs: NOW_MS };
  const service = new BookingIntentService(
    intentRepo,
    slotRepo,
    () => new Date(clock.nowMs).toISOString(),
    () => clock.nowMs,
  );
  return { slotRepo, intentRepo, service, clock };
}

function expectBookingIntentError(fn: () => unknown, status: number): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(BookingIntentError);
  expect((caught as BookingIntentError).status).toBe(status);
}

describe("BookingIntentService.autoRefundHold", () => {
  let slotRepo: InMemorySlotRepository;
  let intentRepo: InMemoryBookingIntentRepository;
  let service: BookingIntentService;
  let clock: { nowMs: number };

  beforeEach(() => {
    ({ slotRepo, intentRepo, service, clock } = createFixture());
  });

  async function createHold(holdUntilMs: number) {
    return service.createIntent(
      {
        slotId: PRICED_SLOT.id,
        bookingType: "refundable_hold",
        holdDeadlineMs: holdUntilMs,
      },
      customer,
    );
  }

  async function createConfirmedStandardIntent() {
    const intent = await service.createIntent(
      { slotId: PRICED_SLOT.id },
      customer,
    );
    return service.confirmIntent(intent.id, customer);
  }

  describe("happy path", () => {
    it("refunds an expired hold_placed refundable hold and releases the slot", async () => {
      const hold = await createHold(NOW_MS - 1000);
      expect(hold.status).toBe("hold_placed");
      expect(slotRepo.findById(PRICED_SLOT.id)?.bookable).toBe(false);

      const refunded = service.autoRefundHold(hold.id);

      expect(refunded.status).toBe("hold_refunded");
      expect(refunded.refundedAt).toBe(new Date(NOW_MS).toISOString());
      expect(refunded.refundMetadata).toMatchObject({
        refundedAt: new Date(NOW_MS).toISOString(),
        refundedAmountCents: BASE_PRICE_CENTS,
        refundReason: "hold_auto_refund",
      });
      expect(slotRepo.findById(PRICED_SLOT.id)?.bookable).toBe(true);
    });

    it("refunds a hold exactly at its holdUntilMs deadline", async () => {
      const hold = await createHold(NOW_MS);

      const refunded = service.autoRefundHold(hold.id);

      expect(refunded.status).toBe("hold_refunded");
      expect(refunded.refundMetadata?.refundedAmountCents).toBe(
        BASE_PRICE_CENTS,
      );
    });
  });

  describe("guards", () => {
    it("throws 409 for a confirmed standard intent and leaves it unchanged (regression)", async () => {
      const confirmed = await createConfirmedStandardIntent();
      expect(confirmed.status).toBe("confirmed");

      expectBookingIntentError(() => service.autoRefundHold(confirmed.id), 409);

      const after = intentRepo.findById(confirmed.id);
      expect(after?.status).toBe("confirmed");
      expect(after?.bookingType).toBe("standard");
      expect(after?.refundedAt).toBeUndefined();
      expect(after?.refundMetadata).toBeUndefined();
      // The slot must stay reserved by the confirmed booking.
      expect(slotRepo.findById(PRICED_SLOT.id)?.bookable).toBe(false);
    });

    it("throws 409 for a pending standard intent (wrong booking type)", async () => {
      const pending = await service.createIntent(
        { slotId: PRICED_SLOT.id },
        customer,
      );

      expectBookingIntentError(() => service.autoRefundHold(pending.id), 409);

      const after = intentRepo.findById(pending.id);
      expect(after?.status).toBe("pending");
      expect(after?.refundMetadata).toBeUndefined();
    });

    it("throws 409 for a refundable hold whose status is not hold_placed (expired)", async () => {
      const hold = await createHold(NOW_MS - 1000);
      service.expireIntent(hold.id);

      expectBookingIntentError(() => service.autoRefundHold(hold.id), 409);

      const after = intentRepo.findById(hold.id);
      expect(after?.status).toBe("expired");
      expect(after?.refundMetadata).toBeUndefined();
    });

    it("throws 404 for an unknown intent", () => {
      expectBookingIntentError(() => service.autoRefundHold("no-such-id"), 404);
    });
  });

  describe("idempotency", () => {
    it("returns 409 on a second auto-refund without creating a second refund record", async () => {
      const hold = await createHold(NOW_MS - 1000);

      const first = service.autoRefundHold(hold.id);
      expect(first.status).toBe("hold_refunded");

      // Advance the clock so a second (buggy) refund would be visible.
      clock.nowMs = NOW_MS + 60_000;

      expectBookingIntentError(() => service.autoRefundHold(hold.id), 409);

      const after = intentRepo.findById(hold.id);
      expect(after?.status).toBe("hold_refunded");
      // Refund record still belongs to the first (only) refund.
      expect(after?.refundedAt).toBe(new Date(NOW_MS).toISOString());
      expect(after?.refundMetadata).toMatchObject({
        refundedAt: new Date(NOW_MS).toISOString(),
        refundedAmountCents: BASE_PRICE_CENTS,
        refundReason: "hold_auto_refund",
      });
    });
  });

  describe("expiry guard", () => {
    it("throws 409 for a hold before its holdUntilMs deadline and leaves it unchanged", async () => {
      const hold = await createHold(NOW_MS + HOLD_DURATION_MS);

      expectBookingIntentError(() => service.autoRefundHold(hold.id), 409);

      const after = intentRepo.findById(hold.id);
      expect(after?.status).toBe("hold_placed");
      expect(after?.refundedAt).toBeUndefined();
      expect(after?.refundMetadata).toBeUndefined();
      expect(slotRepo.findById(PRICED_SLOT.id)?.bookable).toBe(false);
    });

    it("refunds a not-yet-expired hold when force is passed explicitly", async () => {
      const hold = await createHold(NOW_MS + HOLD_DURATION_MS);

      const refunded = service.autoRefundHold(hold.id, { force: true });

      expect(refunded.status).toBe("hold_refunded");
      expect(refunded.refundMetadata?.refundedAmountCents).toBe(
        BASE_PRICE_CENTS,
      );
      expect(slotRepo.findById(PRICED_SLOT.id)?.bookable).toBe(true);
    });

    it("does not let force bypass the booking type or status guards", async () => {
      const confirmed = await createConfirmedStandardIntent();

      expectBookingIntentError(
        () => service.autoRefundHold(confirmed.id, { force: true }),
        409,
      );
      expect(intentRepo.findById(confirmed.id)?.status).toBe("confirmed");
    });
  });
});
