import request from "supertest";
import express from "express";
import { jest } from "@jest/globals";
import { createApp } from "../../app.js";
import { setFeatureFlagsFromEnv } from "../../flags/service.js";
import { anomalyReviewQueue } from "../../services/anomalyScoring.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";
import { createBookingIntentsRouter } from "../../routes/booking-intents.js";
import { featureFlagContextMiddleware } from "../../middleware/featureFlags.js";

// The anomaly scorers inside createApp() and createBookingIntentsRouter() are
// constructed when those factories run, so the relaxed threshold must be set
// before app creation. With it, a single unrecognized device fingerprint
// (signal 0.25 * weight 0.2 = 0.05) crosses the flag boundary, letting these
// tests exercise flagging deterministically without timing-sensitive bursts.
process.env.ANOMALY_FLAG_THRESHOLD = "0.01";

const app = createApp({ enableDocs: false });

// Modern router under test (createApp mounts a legacy duplicate of POST
// /api/v1/booking-intents, so the router is exercised standalone here).
const routerApp = express();
routerApp.set("trust proxy", 1);
routerApp.use(express.json());
routerApp.use(featureFlagContextMiddleware);
routerApp.use("/api/v1/booking-intents", createBookingIntentsRouter());

// Seeded by InMemorySlotRepository's DEFAULT_SLOTS (bookable, owned by alice/bob).
const ALICE_SLOT = "slot-11111111-1111-4111-8111-111111111111";
const BOB_SLOT = "slot-22222222-2222-4222-8222-222222222222";

const customerHeaders = {
  "x-chronopay-user-id": "cust-anomaly",
  "x-chronopay-role": "customer",
};

const adminHeaders = {
  "x-chronopay-user-id": "admin-1",
  "x-chronopay-role": "admin",
};

beforeAll(() => {
  process.env.FF_CREATE_BOOKING_INTENT = "true";
  setFeatureFlagsFromEnv(process.env);
});

afterAll(() => {
  delete process.env.FF_CREATE_BOOKING_INTENT;
  delete process.env.ANOMALY_FLAG_THRESHOLD;
  setFeatureFlagsFromEnv(process.env);
});

describe("Anomaly review queue integration", () => {
  // The router's auditMiddleware validates req.ip, which supertest presents as
  // an IPv4-mapped IPv6 address that the audit validator rejects. Same
  // workaround as booking-intents-idempotency.test.ts.
  let auditSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    auditSpy = jest.spyOn(defaultAuditLogger, "log").mockResolvedValue();
    anomalyReviewQueue._reset();
  });

  afterEach(() => {
    auditSpy.mockRestore();
    anomalyReviewQueue._reset();
  });

  describe("GET /api/v1/admin/anomaly-queue", () => {
    it("requires authentication", async () => {
      const res = await request(app).get("/api/v1/admin/anomaly-queue");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("forbids non-admin actors", async () => {
      const res = await request(app)
        .get("/api/v1/admin/anomaly-queue")
        .set(customerHeaders);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("returns an empty queue when nothing was flagged", async () => {
      const res = await request(app)
        .get("/api/v1/admin/anomaly-queue")
        .set(adminHeaders);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, items: [] });
    });

    it("lists flagged intents created through the deployed booking-intent handler", async () => {
      const created = await request(app)
        .post("/api/v1/booking-intents")
        .set(customerHeaders)
        .set("x-device-fingerprint", "device-abc")
        .send({ slotId: ALICE_SLOT });

      expect(created.status).toBe(201);
      const intent = created.body.bookingIntent;
      expect(intent.anomalyFlagged).toBe(true);
      expect(intent.anomalyScore).toBeCloseTo(0.05, 10);
      expect(intent.anomalySignals).toMatchObject({ fingerprintRisk: 0.25 });

      const listed = await request(app)
        .get("/api/v1/admin/anomaly-queue")
        .set(adminHeaders);

      expect(listed.status).toBe(200);
      const items = listed.body.items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        intentId: intent.id,
        customerId: "cust-anomaly",
        reasons: ["unrecognized_device_fingerprint"],
      });
      expect(items[0].score).toBeCloseTo(0.05, 10);
      expect(items[0].signals).toMatchObject({
        velocity: 0,
        fingerprintRisk: 0.25,
        geoHopDistance: 0,
        buyerAge: 0,
      });
      expect(typeof items[0].flaggedAt).toBe("string");
    });

    it("does not list unflagged intents", async () => {
      const created = await request(app)
        .post("/api/v1/booking-intents")
        .set({
          "x-chronopay-user-id": "cust-benign",
          "x-chronopay-role": "customer",
        })
        // No device fingerprint and no history -> every signal stays 0.
        .send({ slotId: BOB_SLOT });

      expect(created.status).toBe(201);
      expect(created.body.bookingIntent.anomalyFlagged).toBe(false);
      expect(created.body.bookingIntent.anomalyScore).toBe(0);

      const listed = await request(app)
        .get("/api/v1/admin/anomaly-queue")
        .set(adminHeaders);

      expect(listed.body.items).toHaveLength(0);
    });

    it("lists intents flagged by the modern booking-intents router", async () => {
      const created = await request(routerApp)
        .post("/api/v1/booking-intents")
        .set(customerHeaders)
        .set("x-device-fingerprint", "device-router")
        .send({ slotId: ALICE_SLOT });

      expect(created.status).toBe(201);
      expect(created.body.intent.anomalyFlagged).toBe(true);

      const listed = await request(app)
        .get("/api/v1/admin/anomaly-queue")
        .set(adminHeaders);

      expect(listed.body.items).toHaveLength(1);
      expect(listed.body.items[0].intentId).toBe(created.body.intent.id);
    });
  });
});
