import request from "supertest";
import { createApp } from "../../app.js";
import { setFeatureFlagsFromEnv } from "../../flags/service.js";

describe("POST /api/v1/booking-intents", () => {
  const app = createApp({
    apiKey: "test-api-key",
  });

  const validUserId = "user-123";
  const validRole = "customer";
  const validSlotId = "slot-100"; // From DEFAULT_SLOTS in InMemorySlotRepository

  beforeEach(() => {
    // Enable the flag by default for most tests
    process.env.FF_CREATE_BOOKING_INTENT = "true";
    setFeatureFlagsFromEnv(process.env);
  });

  afterAll(() => {
    delete process.env.FF_CREATE_BOOKING_INTENT;
    setFeatureFlagsFromEnv(process.env);
  });

  describe("Security and Guards", () => {
    it("should return 503 if CREATE_BOOKING_INTENT feature flag is disabled", async () => {
      process.env.FF_CREATE_BOOKING_INTENT = "false";
      setFeatureFlagsFromEnv(process.env);

      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .send({ slotId: validSlotId });

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        success: false,
        error: "Feature CREATE_BOOKING_INTENT is currently disabled",
        code: "FEATURE_DISABLED",
      });
    });

    it("should return 401 if x-chronopay-user-id is missing", async () => {
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-role", validRole)
        .send({ slotId: validSlotId });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        success: false,
        error: "Authentication required.",
        code: "AUTHENTICATION_REQUIRED",
      });
    });

    it("should return 403 if role is not authorized", async () => {
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", "professional") // Professional is not allowed in router
        .send({ slotId: validSlotId });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        success: false,
        error: "Role is not authorized for this action.",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    });
  });

  describe("Functionality", () => {
    it("should create a booking intent successfully", async () => {
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .send({ 
          slotId: validSlotId,
          note: "Please be on time"
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.intent).toMatchObject({
        slotId: validSlotId,
        customerId: validUserId,
        status: "pending",
        note: "Please be on time"
      });
      expect(response.body.intent.id).toBeDefined();
    });

    it("should return 409 if slot is not bookable", async () => {
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .send({ slotId: "slot-102" }); // slot-102 is bookable: false

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        success: false,
        error: "Selected slot is not bookable.",
      });
    });

    it("should return 409 if a booking intent already exists for this slot", async () => {
      // First creation
      await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .send({ slotId: "slot-101" });

      // Second creation for same slot (by anyone)
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "another-user")
        .set("x-chronopay-role", validRole)
        .send({ slotId: "slot-101" });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        success: false,
        error: "Selected slot already has an active booking intent.",
      });
    });

    it("should return 403 if professional books their own slot", async () => {
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "alice") // slot-100 belongs to alice
        .set("x-chronopay-role", "admin") // alice is admin here
        .send({ slotId: "slot-100" });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        success: false,
        error: "You cannot create a booking intent for your own slot.",
      });
    });
  });
});
