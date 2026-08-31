import request from "supertest";
import express from "express";
import { createBookingIntentsRouter } from "../routes/booking-intents.js";
import { setFeatureFlagsFromEnv } from "../flags/service.js";
import { featureFlagContextMiddleware } from "../middleware/featureFlags.js";
import {
  InMemoryBookingIntentRepository,
  type BookingIntentRecord,
} from "../modules/booking-intents/booking-intent-repository.js";
import { BookingIntentService } from "../modules/booking-intents/booking-intent-service.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";

// Minimal valid intent fields (minus id, which the repo assigns)
const BASE_INTENT: Omit<BookingIntentRecord, "id"> = {
  slotId: "slot-1",
  professional: "pro-1",
  customerId: "user1",
  startTime: 1000,
  endTime: 2000,
  status: "pending",
  createdAt: new Date().toISOString(),
};

// Slot seeded in InMemorySlotRepository's DEFAULT_SLOTS that is bookable
// and owned by "alice" (not "user1" or "user2"), so no self-booking conflict.
const ALICE_SLOT_ID = "slot-11111111-1111-4111-8111-111111111111";

describe("booking intents endpoints", () => {
  let app: express.Express;
  let repo: InMemoryBookingIntentRepository;

  beforeEach(() => {
    process.env.FF_CREATE_BOOKING_INTENT = "true";
    setFeatureFlagsFromEnv(process.env);
    repo = new InMemoryBookingIntentRepository();
    app = express();
    app.use(express.json());
    app.use(featureFlagContextMiddleware);
    app.use(
      "/api/v1/booking-intents",
      createBookingIntentsRouter({ bookingIntentRepository: repo }),
    );
  });

  afterAll(() => {
    delete process.env.FF_CREATE_BOOKING_INTENT;
    setFeatureFlagsFromEnv(process.env);
  });

  // ─── GET /:id ───────────────────────────────────────────────────────────────

  describe("GET /:id", () => {
    it("returns 404 when intent does not exist", async () => {
      const res = await request(app)
        .get("/api/v1/booking-intents/intent-999")
        .set("x-chronopay-user-id", "user1")
        .set("x-chronopay-role", "customer");
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("returns 404 when intent belongs to another customer (no existence leak)", async () => {
      repo.create({ ...BASE_INTENT, customerId: "other-user" });
      const res = await request(app)
        .get("/api/v1/booking-intents/intent-1")
        .set("x-chronopay-user-id", "user1")
        .set("x-chronopay-role", "customer");
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("returns the intent for the owner", async () => {
      repo.create({ ...BASE_INTENT, customerId: "user1" });
      const res = await request(app)
        .get("/api/v1/booking-intents/intent-1")
        .set("x-chronopay-user-id", "user1")
        .set("x-chronopay-role", "customer");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.intent.id).toBe("intent-1");
      expect(res.body.intent.customerId).toBe("user1");
    });

    it("returns the intent for an admin regardless of owner", async () => {
      repo.create({ ...BASE_INTENT, customerId: "other-user" });
      const res = await request(app)
        .get("/api/v1/booking-intents/intent-1")
        .set("x-chronopay-user-id", "admin1")
        .set("x-chronopay-role", "admin");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.intent.id).toBe("intent-1");
    });

    it("returns 401 when no auth headers are provided", async () => {
      repo.create({ ...BASE_INTENT });
      const res = await request(app).get("/api/v1/booking-intents/intent-1");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET / ──────────────────────────────────────────────────────────────────

  describe("GET /", () => {
    it("returns only the authenticated customer's intents", async () => {
      repo.create({ ...BASE_INTENT, customerId: "user1" });
      repo.create({ ...BASE_INTENT, customerId: "user1", slotId: "slot-2" });
      repo.create({ ...BASE_INTENT, customerId: "other-user", slotId: "slot-3" });

      const res = await request(app)
        .get("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "user1")
        .set("x-chronopay-role", "customer");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.intents).toHaveLength(2);
      expect(res.body.intents.every((i: BookingIntentRecord) => i.customerId === "user1")).toBe(
        true,
      );
    });

    it("returns all intents for an admin", async () => {
      repo.create({ ...BASE_INTENT, customerId: "user1" });
      repo.create({ ...BASE_INTENT, customerId: "user2", slotId: "slot-2" });

      const res = await request(app)
        .get("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "admin1")
        .set("x-chronopay-role", "admin");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.intents).toHaveLength(2);
    });

    it("returns an empty array when the customer has no intents", async () => {
      const res = await request(app)
        .get("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "user1")
        .set("x-chronopay-role", "customer");
      expect(res.status).toBe(200);
      expect(res.body.intents).toEqual([]);
    });

    it("returns 401 when no auth headers are provided", async () => {
      const res = await request(app).get("/api/v1/booking-intents");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /:id/no-show", () => {
    it("allows a supplier to mark a confirmed booking as a no-show and forfeit escrow share", async () => {
      const created = await repo.create({
        ...BASE_INTENT,
        id: "intent-no-show-1",
        professional: "pro-1",
        customerId: "user1",
        status: "confirmed",
        pricingSnapshot: {
          strategyId: "fixed",
          resolvedPrice: 1500,
          basePrice: 1500,
          slotStartMs: 1000,
          nowMs: 1500,
          activeBookings: 1,
          capacity: 1,
          config: {},
        },
      });

      const res = await request(app)
        .post("/api/v1/booking-intents/intent-no-show-1/no-show")
        .send({ reason: "Buyer did not arrive", forfeitRatio: 0.2 })
        .set("x-chronopay-user-id", "pro-1")
        .set("x-chronopay-role", "professional");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.result.status).toBe("no_show");
      expect(res.body.result.forfeitAmountCents).toBe(300);
      expect(res.body.result.reputationDelta).toBeLessThan(0);
      expect(res.body.result.buyerId).toBe("user1");
    });

    it("rejects a customer from marking no-show", async () => {
      await repo.create({
        ...BASE_INTENT,
        id: "intent-no-show-2",
        professional: "pro-1",
        customerId: "user1",
      });

      const res = await request(app)
        .post("/api/v1/booking-intents/intent-no-show-2/no-show")
        .send({ reason: "No show" })
        .set("x-chronopay-user-id", "user1")
        .set("x-chronopay-role", "customer");

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("rejects invalid forfeit ratios", async () => {
      await repo.create({
        ...BASE_INTENT,
        id: "intent-no-show-3",
        professional: "pro-1",
        customerId: "user1",
      });

      const res = await request(app)
        .post("/api/v1/booking-intents/intent-no-show-3/no-show")
        .send({ forfeitRatio: 2 })
        .set("x-chronopay-user-id", "pro-1")
        .set("x-chronopay-role", "professional");

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});

// ─── Concurrent-create: at-most-one active intent per slot ───────────────────
//
// The partial unique index (migration 019) is the DB-level guarantee.
// This suite verifies the same invariant at the service layer, which the
// index mirrors: exactly one of N concurrent creates for the same slot wins;
// the rest receive 409 CONFLICT.
//
// The "after terminal state" case verifies that the partial index (and the
// in-memory analogue) allows a new intent once the prior one is no longer
// active — i.e. the constraint is partial, not global.

describe("concurrent booking-intent creates — one active per slot", () => {
  // Build a lightweight app wired to explicit repos so we can control state.
  function makeServiceApp(userId = "user1") {
    const slotRepo = new InMemorySlotRepository();
    const intentRepo = new InMemoryBookingIntentRepository();
    const service = new BookingIntentService(intentRepo, slotRepo);

    const app = express();
    app.use(express.json());

    // Thin router that bypasses auth/feature-flag middleware for these tests.
    // Mirrors exactly what the real POST / handler does after auth passes.
    app.post("/intents", async (req: any, res: any) => {
      try {
        const intent = await service.createIntent(req.body, {
          userId: (req.headers["x-user-id"] as string) ?? userId,
          role: "customer",
        });
        res.status(201).json({ success: true, intent });
      } catch (err: any) {
        res.status(err.statusCode ?? err.status ?? 500).json({
          success: false,
          error: err.message,
          code: err.code,
        });
      }
    });

    return { app, intentRepo, slotRepo, service };
  }

  it("exactly one of 5 concurrent creates for the same slot succeeds", async () => {
    const { app } = makeServiceApp();

    const body = {
      slotId: ALICE_SLOT_ID,
    };

    const requests = Array.from({ length: 5 }, (_, i) =>
      request(app).post("/intents").set("x-user-id", `customer-${i}`).send(body),
    );

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status);

    const created = statuses.filter((s) => s === 201);
    const conflicted = statuses.filter((s) => s === 409);

    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(4);

    const conflictBodies = responses.filter((r) => r.status === 409).map((r) => r.body);
    conflictBodies.forEach((body) => {
      expect(body.success).toBe(false);
      expect(body.code).toBe("CONFLICT");
    });
  });

  it("allows a new intent for a slot once the prior intent is no longer active", async () => {
    const { service } = makeServiceApp();

    const actor = { userId: "user1", role: "customer" as const };

    // Create the first intent and cancel it (terminal state releases the slot).
    const first = await service.createIntent({ slotId: ALICE_SLOT_ID }, actor);
    service.cancelIntent(first.id, actor);

    // A second create for the same slot should now succeed because the prior
    // intent is no longer active (the in-memory analogue of the partial index).
    const second = await service.createIntent({ slotId: ALICE_SLOT_ID }, actor);
    expect(second.slotId).toBe(ALICE_SLOT_ID);
    expect(second.status).toBe("pending");
  });
});
