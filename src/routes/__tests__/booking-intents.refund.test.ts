import request from "supertest";
import express from "express";
import { createBookingIntentsRouter } from "../booking-intents.js";
import { setFeatureFlagsFromEnv } from "../../flags/service.js";
import { featureFlagContextMiddleware } from "../../middleware/featureFlags.js";
import {
  InMemoryBookingIntentRepository,
  type BookingIntentRecord,
} from "../../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository, type SlotRecord } from "../../modules/slots/slot-repository.js";

describe("POST /api/v1/booking-intents/:id/refund (Router security & guards)", () => {
  let app: express.Express;
  let repo: InMemoryBookingIntentRepository;
  let slotRepo: InMemorySlotRepository;

  const CUSTOMER_ID = "cust-router-1";
  const OTHER_CUSTOMER_ID = "cust-router-2";
  const ADMIN_ID = "admin-router-1";
  const SLOT_ID_1 = "slot-refund-test-1";
  const SLOT_ID_2 = "slot-refund-test-2";

  const customerHeaders = {
    "x-chronopay-user-id": CUSTOMER_ID,
    "x-chronopay-role": "customer",
  };

  const adminHeaders = {
    "x-chronopay-user-id": ADMIN_ID,
    "x-chronopay-role": "admin",
  };

  const seedSlot1: SlotRecord = {
    id: SLOT_ID_1,
    professional: "prof-router-1",
    startTime: 1_000_000,
    endTime: 2_000_000,
    bookable: false,
  };

  const seedSlot2: SlotRecord = {
    id: SLOT_ID_2,
    professional: "prof-router-1",
    startTime: 1_000_000,
    endTime: 2_000_000,
    bookable: false,
  };

  const makeIntent = (overrides: Partial<BookingIntentRecord> = {}): Omit<BookingIntentRecord, "id"> => ({
    slotId: SLOT_ID_1,
    professional: "prof-router-1",
    customerId: CUSTOMER_ID,
    startTime: 1_000_000,
    endTime: 2_000_000,
    status: "confirmed",
    createdAt: new Date().toISOString(),
    pricingSnapshot: {
      strategyId: "fixed",
      resolvedPrice: 10_000,
      basePrice: 10_000,
      slotStartMs: 1_000_000,
      nowMs: 0,
      activeBookings: 1,
      capacity: 1,
      config: {},
    },
    ...overrides,
  });

  beforeEach(() => {
    process.env.FF_CREATE_BOOKING_INTENT = "true";
    setFeatureFlagsFromEnv(process.env);

    repo = new InMemoryBookingIntentRepository();
    slotRepo = new InMemorySlotRepository([seedSlot1, seedSlot2]);

    app = express();
    app.use(express.json());
    app.use(featureFlagContextMiddleware);
    app.use(
      "/api/v1/booking-intents",
      createBookingIntentsRouter({
        bookingIntentRepository: repo,
        slotRepository: slotRepo,
      }),
    );
  });

  afterAll(() => {
    delete process.env.FF_CREATE_BOOKING_INTENT;
    setFeatureFlagsFromEnv(process.env);
  });

  describe("Customer backdating prevention", () => {
    it("customer refund with backdated cancelledAtMs ignores it and returns the same amount as server clock", async () => {
      // Intent slot is 1_000_000 -> 2_000_000.
      // Server clock is currently ~1.7e12 (in 2026), well past 2_000_000, so duration consumed is 100%.
      const intentWithBackdate = await repo.create(makeIntent({ slotId: SLOT_ID_1 }));
      const intentWithoutBackdate = await repo.create(makeIntent({ slotId: SLOT_ID_2 }));

      // Request 1: with backdated cancelledAtMs = 500_000 (before startTime)
      const resWithBackdate = await request(app)
        .post(`/api/v1/booking-intents/${intentWithBackdate.id}/refund`)
        .set(customerHeaders)
        .send({ cancelledAtMs: 500_000, reason: "customer_requested" });

      expect(resWithBackdate.status).toBe(200);
      expect(resWithBackdate.body.success).toBe(true);

      // Request 2: without cancelledAtMs
      const resWithoutBackdate = await request(app)
        .post(`/api/v1/booking-intents/${intentWithoutBackdate.id}/refund`)
        .set(customerHeaders)
        .send({ reason: "customer_requested" });

      expect(resWithoutBackdate.status).toBe(200);
      expect(resWithoutBackdate.body.success).toBe(true);

      // Amounts must be identical (server clock governs, client override ignored)
      expect(resWithBackdate.body.refund.refundAmountCents).toBe(
        resWithoutBackdate.body.refund.refundAmountCents,
      );
      // Because current server time is past 2_000_000, refundAmountCents is 0, NOT 10_000 full refund
      expect(resWithBackdate.body.refund.refundAmountCents).toBe(0);
      expect(resWithBackdate.body.refund.consumedRatio).toBe(1);
    });

    it("rejects non-numeric cancelledAtMs with 400", async () => {
      const intent = await repo.create(makeIntent());

      const res = await request(app)
        .post(`/api/v1/booking-intents/${intent.id}/refund`)
        .set(customerHeaders)
        .send({ cancelledAtMs: "not-a-number" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("cancelledAtMs must be a valid number.");
    });
  });

  describe("Admin override", () => {
    it("allows admin to backdate refund with cancelledAtMs <= now", async () => {
      // Intent slot: 1_000_000 -> 2_000_000 (duration: 1_000_000 ms)
      const intent = await repo.create(makeIntent());

      // Backdate to 1_500_000 (50% consumed)
      const res = await request(app)
        .post(`/api/v1/booking-intents/${intent.id}/refund`)
        .set(adminHeaders)
        .send({ cancelledAtMs: 1_500_000, reason: "admin_adjustment" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.refund.refundAmountCents).toBe(5_000); // 50% of 10_000 cents
      expect(res.body.refund.refundRatio).toBeCloseTo(0.5, 5);
    });

    it("rejects admin override with future cancelledAtMs with 400", async () => {
      const intent = await repo.create(makeIntent());

      const futureTime = Date.now() + 100_000;
      const res = await request(app)
        .post(`/api/v1/booking-intents/${intent.id}/refund`)
        .set(adminHeaders)
        .send({ cancelledAtMs: futureTime, reason: "admin_adjustment" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Admin override cancelledAtMs cannot be in the future.");
    });
  });

  describe("Status guards & double-refund prevention", () => {
    it("returns 409 when refunding an intent with status no_show", async () => {
      const intent = await repo.create(makeIntent({ status: "no_show" }));

      const res = await request(app)
        .post(`/api/v1/booking-intents/${intent.id}/refund`)
        .set(customerHeaders)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Cannot refund intent with status "no_show".');
    });

    it("returns 409 on second refund attempt on an already-refunded intent", async () => {
      const intent = await repo.create(makeIntent());

      // First refund: 200 OK
      const firstRes = await request(app)
        .post(`/api/v1/booking-intents/${intent.id}/refund`)
        .set(customerHeaders)
        .send({ reason: "first_refund" });

      expect(firstRes.status).toBe(200);

      // Second refund: 409 Conflict
      const secondRes = await request(app)
        .post(`/api/v1/booking-intents/${intent.id}/refund`)
        .set(customerHeaders)
        .send({ reason: "second_refund" });

      expect(secondRes.status).toBe(409);
      expect(secondRes.body.success).toBe(false);
      expect(secondRes.body.error).toBe("Intent has already been refunded.");
    });

    it("returns 409 when refunding an intent that already has refundMetadata", async () => {
      const intent = await repo.create(
        makeIntent({
          refundMetadata: {
            refundedAt: new Date().toISOString(),
            refundedAmountCents: 5_000,
            refundReason: "prior_refund",
          },
        }),
      );

      const res = await request(app)
        .post(`/api/v1/booking-intents/${intent.id}/refund`)
        .set(customerHeaders)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Intent has already been refunded.");
    });
  });

  describe("Authorization", () => {
    it("returns 403 when a customer attempts to refund another customer's intent", async () => {
      const intent = await repo.create(makeIntent());

      const res = await request(app)
        .post(`/api/v1/booking-intents/${intent.id}/refund`)
        .set({
          "x-chronopay-user-id": OTHER_CUSTOMER_ID,
          "x-chronopay-role": "customer",
        })
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });
});
