import request from "supertest";
import { createApp } from "../../app.js";
import { setFeatureFlagsFromEnv } from "../../flags/service.js";
import { performance } from "perf_hooks";

describe("GET /api/v1/booking-intents/:id/cancel-preview", () => {
  const app = createApp({
    apiKey: "test-api-key",
  });

  const validUserId = "user-123";
  const validRole = "customer";

  beforeEach(() => {
    process.env.FF_CREATE_BOOKING_INTENT = "true";
    setFeatureFlagsFromEnv(process.env);
  });

  afterAll(() => {
    delete process.env.FF_CREATE_BOOKING_INTENT;
    setFeatureFlagsFromEnv(process.env);
  });

  it("should preview cancellation successfully and meet p95 latency budget", async () => {
    // Create intent
    const createRes = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", validUserId)
      .set("x-chronopay-role", validRole)
      .send({ slotId: "slot-11111111-1111-4111-8111-111111111111" });

    const intentId = createRes.body.intent.id;

    const start = performance.now();
    const res = await request(app)
      .get(`/api/v1/booking-intents/${intentId}/cancel-preview`)
      .set("x-chronopay-user-id", validUserId)
      .set("x-chronopay-role", validRole);
    const end = performance.now();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preview).toBeDefined();
    expect(res.body.preview.policyVersion).toBe("v2-prorated");
    expect(res.body.preview.fee).toBeDefined();
    expect(res.body.preview.taxReversal).toBeDefined();
    expect(res.body.preview.netRefund).toBeDefined();

    // Latency assertion for p95 budget (usually < 50ms for in-memory)
    expect(end - start).toBeLessThan(100);
  });

  it("should return 200 preview after the intent is cancelled", async () => {
    const createRes = await request(app)
      .post("/api/v1/booking-intents")
      .set("x-chronopay-user-id", validUserId)
      .set("x-chronopay-role", validRole)
      .send({ slotId: "slot-22222222-2222-4222-8222-222222222222" });
    const intentId = createRes.body.intent.id;

    await request(app)
      .post(`/api/v1/booking-intents/${intentId}/cancel`)
      .set("x-chronopay-user-id", validUserId)
      .set("x-chronopay-role", validRole);

    const res = await request(app)
      .get(`/api/v1/booking-intents/${intentId}/cancel-preview`)
      .set("x-chronopay-user-id", validUserId)
      .set("x-chronopay-role", validRole);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.preview).toBeDefined();
  });
});
