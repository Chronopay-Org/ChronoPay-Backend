import request from "supertest";
import { createApp } from "../../app.js";
import { setFeatureFlagsFromEnv } from "../../flags/service.js";

// DEFAULT_SLOTS in InMemorySlotRepository. Only these start times are bookable.
const SLOT_A_START = "2030-03-17T17:46:40.000Z"; // slot-1111... bookable
const SLOT_A_ID = "slot-11111111-1111-4111-8111-111111111111";
const SLOT_B_START = "2030-03-17T17:58:40.000Z"; // slot-2222... bookable
const SLOT_B_ID = "slot-22222222-2222-4222-8222-222222222222";

describe("POST /api/v1/booking-intents (recurring / RRULE)", () => {
  // A single app instance is shared across the file (the Redis-backed rate
  // limiter store is a module-level singleton, so a second createApp() throws
  // ERR_ERL_STORE_REUSE). Booking state therefore persists in declaration order.
  const app = createApp({ apiKey: "test-api-key" });

  const headers = (userId = "recurring-buyer-1", role = "customer") => ({
    "x-chronopay-user-id": userId,
    "x-chronopay-role": role,
  });

  const RULE_SLOT_A = `DTSTART:20300317T174640Z\nRRULE:FREQ=DAILY;COUNT=1`;

  beforeEach(() => {
    process.env.FF_CREATE_BOOKING_INTENT = "true";
    setFeatureFlagsFromEnv(process.env);
  });

  afterAll(() => {
    delete process.env.FF_CREATE_BOOKING_INTENT;
    setFeatureFlagsFromEnv(process.env);
  });

  describe("authorization and feature-flag boundaries", () => {
    it("returns 503 when the feature flag is disabled", async () => {
      process.env.FF_CREATE_BOOKING_INTENT = "false";
      setFeatureFlagsFromEnv(process.env);

      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set(headers())
        .send({ rrule: RULE_SLOT_A });

      expect(response.status).toBe(503);
      expect(response.body.code).toBe("FEATURE_DISABLED");
    });

    it("returns 401 when the buyer is unauthenticated", async () => {
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-role", "customer")
        .send({ rrule: RULE_SLOT_A });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toEqual(expect.any(String));
    });

    it("returns 403 for a role outside the allowed set", async () => {
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set(headers("recurring-buyer-1", "professional"))
        .send({ rrule: RULE_SLOT_A });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toEqual(expect.any(String));
    });

    it("allows an admin through RBAC (reaching materialization, no false 403)", async () => {
      // Anchor on a start time with no matching slot: the point is that an
      // admin is not rejected by the route, not that this test books anything.
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set(headers("recurring-admin-1", "admin"))
        .send({ rrule: `DTSTART:20260701T100000Z\nRRULE:FREQ=DAILY;COUNT=1` });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.report).toBeDefined();
      expect(response.body.report.failures.length).toBeGreaterThan(0);
    });
  });

  describe("invalid and boundary inputs", () => {
    it.each([
      ["empty string", { rrule: "" }],
      ["whitespace", { rrule: "   " }],
      ["unbounded (no COUNT/UNTIL)", { rrule: "FREQ=WEEKLY;BYDAY=MO" }],
      ["malformed", { rrule: "INVALID=FORMAT;COUNT=5" }],
      ["ambiguous floating DTSTART", { rrule: "DTSTART:20261101T013000\nFREQ=DAILY;COUNT=3" }],
    ])("rejects %s rrule with 400", async (_label, payload) => {
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set(headers())
        .send(payload);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toEqual(expect.any(String));
    });

    it("rejects a rule that expands beyond the safe maximum with 400", async () => {
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set(headers())
        .send({ rrule: `DTSTART:20260101T100000Z\nRRULE:FREQ=DAILY;COUNT=201` });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/more than/);
    });

    it("rejects a payload carrying both slotId and rrule (ambiguous input)", async () => {
      const response = await request(app).post("/api/v1/booking-intents").set(headers()).send({
        slotId: SLOT_A_ID,
        rrule: RULE_SLOT_A,
      });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/mutually exclusive/i);
    });
  });

  describe("recurring materialization", () => {
    it("materializes a bounded RRULE into booking intents", async () => {
      const response = await request(app).post("/api/v1/booking-intents").set(headers()).send({
        rrule: RULE_SLOT_A,
        note: "standing weekly slot",
      });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.report).toBeDefined();
      expect(response.body.report.successes).toHaveLength(1);
      expect(response.body.report.failures).toEqual([]);
      expect(response.body.report.successes[0]).toMatchObject({
        slotId: SLOT_A_ID,
        customerId: "recurring-buyer-1",
        status: "pending",
        startTime: Date.parse(SLOT_A_START),
        note: "standing weekly slot",
      });
    });

    it("is safe to re-submit: the second attempt books nothing and flags conflicts", async () => {
      // Depends on the happy-path test above having reserved slot A.
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set(headers())
        .send({ rrule: RULE_SLOT_A });

      expect(response.status).toBe(201);
      expect(response.body.report.successes).toEqual([]);
      expect(response.body.report.failures).toHaveLength(1);
      expect(response.body.report.failures[0].reason).toBe("No available slot at this time");
    });

    it("returns a partial-success report when some occurrences conflict with inventory", async () => {
      // Only day 1 (slot B @ 17:58:40Z) is bookable; days 2-3 have no slot.
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set(headers("recurring-buyer-2"))
        .send({ rrule: `DTSTART:20300317T175840Z\nRRULE:FREQ=DAILY;COUNT=3` });

      expect(response.status).toBe(201);
      expect(response.body.report.successes).toHaveLength(1);
      expect(response.body.report.successes[0]).toMatchObject({
        slotId: SLOT_B_ID,
        customerId: "recurring-buyer-2",
        startTime: Date.parse(SLOT_B_START),
      });
      expect(response.body.report.failures).toHaveLength(2);
      for (const failure of response.body.report.failures) {
        expect(failure.reason).toBe("No available slot at this time");
        expect(failure.date).toEqual(expect.any(String));
      }
    });
  });
});
