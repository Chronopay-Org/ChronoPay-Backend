import request from "supertest";
import express from "express";
import { createBookingIntentsRouter } from "../routes/booking-intents.js";
import {
  InMemoryBookingIntentRepository,
  type BookingIntentRecord,
} from "../modules/booking-intents/booking-intent-repository.js";

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

describe("booking intents endpoints", () => {
  let app: express.Express;
  let repo: InMemoryBookingIntentRepository;

  beforeEach(() => {
    repo = new InMemoryBookingIntentRepository();
    app = express();
    app.use(express.json());
    // @ts-expect-error - Auto-fixed by script
    app.use("/api/v1/booking-intents", createBookingIntentsRouter(repo));
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
      expect(res.body.intents.every((i: BookingIntentRecord) => i.customerId === "user1")).toBe(true);
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
});
