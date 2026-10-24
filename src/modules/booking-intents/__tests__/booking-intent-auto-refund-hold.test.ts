import {
  BookingIntentService,
  BookingIntentError,
} from "../booking-intent-service.js";
import {
  InMemoryBookingIntentRepository,
  type BookingIntentRecord,
} from "../booking-intent-repository.js";
import {
  InMemorySlotRepository,
  type SlotRecord,
} from "../../slots/slot-repository.js";
import type { AuthContext } from "../../../middleware/auth.js";
import type { VerifiedJwtPayload } from "../../../utils/jwt.js";

const dummyClaims = {} as VerifiedJwtPayload;

const NOW_MS = 1_900_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const HOUR_MS = 60 * 60 * 1000;
const BASE_PRICE_CENTS = 5000;

const PRICED_SLOT: SlotRecord = {
  id: "slot-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  professional: "alice",
  startTime: NOW_MS + 24 * HOUR_MS,
  endTime: NOW_MS + 25 * HOUR_MS,
  bookable: true,
  pricingStrategy: {
    strategyId: "fixed",
    basePrice: BASE_PRICE_CENTS,
    capacity: 1,
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

/** Awaits the promise and returns the thrown error, or undefined on resolve. */
async function captureError(
  promise: Promise<unknown>,
): Promise<BookingIntentError | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err as BookingIntentError;
  }
}

async function expect409(promise: Promise<unknown>): Promise<void> {
  const err = await captureError(promise);
  expect(err).toBeInstanceOf(BookingIntentError);
  expect(err?.status).toBe(409);
}

function intentIn(
  intentRepo: InMemoryBookingIntentRepository,
  id: string,
): BookingIntentRecord | undefined {
  return intentRepo.findById(id);
}

describe("BookingIntentService.autoRefundHold", () => {
  let slotRepo: InMemorySlotRepository;
  let intentRepo: InMemoryBookingIntentRepository;
  let service: BookingIntentService;
  let clock: { nowMs: number };

  beforeEach(() => {
    ({ slotRepo, intentRepo, service, clock } = createFixture());
  });

  async function createHold(holdUntilMs: number | undefined) {
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

      const refunded = await service.autoRefundHold(hold.id);

      expect(refunded.status).toBe("hold_refunded");
      expect(refunded.refundedAt).toBe(NOW_ISO);
      expect(refunded.refundMetadata).toEqual({
        refundedAt: NOW_ISO,
        refundedAmountCents: BASE_PRICE_CENTS,
        refundReason: "hold_auto_refund",
      });
      expect(slotRepo.findById(PRICED_SLOT.id)?.bookable).toBe(true);
    });

    it("refunds a hold exactly at its holdUntilMs deadline", async () => {
      const hold = await createHold(NOW_MS);

      const refunded = await service.autoRefundHold(hold.id);

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

      await expect409(service.autoRefundHold(confirmed.id));

      const after = intentIn(intentRepo, confirmed.id);
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

      await expect409(service.autoRefundHold(pending.id));

      const after = intentIn(intentRepo, pending.id);
      expect(after?.status).toBe("pending");
      expect(after?.refundMetadata).toBeUndefined();
    });

    it("throws 409 for a refundable hold whose status is not hold_placed (expired)", async () => {
      const hold = await createHold(NOW_MS - 1000);
      await service.expireIntent(hold.id);

      await expect409(service.autoRefundHold(hold.id));

      const after = intentIn(intentRepo, hold.id);
      expect(after?.status).toBe("expired");
      expect(after?.refundMetadata).toBeUndefined();
    });

    it("throws 404 for an unknown intent", async () => {
      const err = await captureError(service.autoRefundHold("no-such-id"));
      expect(err).toBeInstanceOf(BookingIntentError);
      expect(err?.status).toBe(404);
    });
  });

  describe("idempotency", () => {
    it("returns 409 on a second auto-refund without creating a second refund record", async () => {
      const hold = await createHold(NOW_MS - 1000);

      const first = await service.autoRefundHold(hold.id);
      expect(first.status).toBe("hold_refunded");

      // Advance the clock so a second (buggy) refund would be visible.
      clock.nowMs = NOW_MS + 60_000;

      await expect409(service.autoRefundHold(hold.id));

      const after = intentIn(intentRepo, hold.id);
      expect(after?.status).toBe("hold_refunded");
      // Refund record still belongs to the first (only) refund.
      expect(after?.refundedAt).toBe(NOW_ISO);
      expect(after?.refundMetadata).toEqual({
        refundedAt: NOW_ISO,
        refundedAmountCents: BASE_PRICE_CENTS,
        refundReason: "hold_auto_refund",
      });
    });
  });

  describe("expiry guard", () => {
    it("throws 409 for a hold before its holdUntilMs deadline and leaves it unchanged", async () => {
      const hold = await createHold(NOW_MS + 30 * 60 * 1000);

      await expect409(service.autoRefundHold(hold.id));

      const after = intentIn(intentRepo, hold.id);
      expect(after?.status).toBe("hold_placed");
      expect(after?.refundedAt).toBeUndefined();
      expect(after?.refundMetadata).toBeUndefined();
      expect(slotRepo.findById(PRICED_SLOT.id)?.bookable).toBe(false);
    });

    it("throws 409 for a hold without a holdUntilMs deadline", async () => {
      const hold = await createHold(undefined);

      await expect409(service.autoRefundHold(hold.id));

      expect(intentIn(intentRepo, hold.id)?.status).toBe("hold_placed");
    });

    it("refunds a not-yet-expired hold when force is passed explicitly", async () => {
      const hold = await createHold(NOW_MS + 30 * 60 * 1000);

      const refunded = await service.autoRefundHold(hold.id, { force: true });

      expect(refunded.status).toBe("hold_refunded");
      expect(refunded.refundMetadata?.refundedAmountCents).toBe(
        BASE_PRICE_CENTS,
      );
      expect(slotRepo.findById(PRICED_SLOT.id)?.bookable).toBe(true);
    });

    it("does not let force bypass the booking type or status guards", async () => {
      const confirmed = await createConfirmedStandardIntent();

      await expect409(
        service.autoRefundHold(confirmed.id, { force: true }),
      );
      expect(intentIn(intentRepo, confirmed.id)?.status).toBe("confirmed");
    });
  });
});
