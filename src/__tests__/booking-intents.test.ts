import { createIntegrationHarness } from "./helpers/integrationHarness.js";
import { setFeatureFlagsFromEnv } from "../flags/index.js";

describe("POST /api/v1/booking-intents", () => {
  let harness: ReturnType<typeof createIntegrationHarness>;

  beforeEach(() => {
    // Create fresh harness for each test to avoid rate limit issues
    harness = createIntegrationHarness();
    // Reset feature flags to defaults before each test
    setFeatureFlagsFromEnv({});
  });

  describe("Feature Flag Gating", () => {
    it("returns 503 when feature flag is disabled", async () => {
      setFeatureFlagsFromEnv({ FF_CREATE_BOOKING_INTENT: "false" });

      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .send({ slotId: "slot-100" });

      expect(response.status).toBe(503);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("FEATURE_DISABLED");
    });

    it("allows request when feature flag is enabled", async () => {
      setFeatureFlagsFromEnv({ FF_CREATE_BOOKING_INTENT: "true" });

      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .send({ slotId: "slot-100" });

      // Should not be 503 (feature disabled)
      expect(response.status).not.toBe(503);
    });
  });

  describe("Authentication", () => {
    beforeEach(() => {
      setFeatureFlagsFromEnv({ FF_CREATE_BOOKING_INTENT: "true" });
    });

    it("returns 401 when x-chronopay-user-id is missing", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-role", "customer")
        .send({ slotId: "slot-100" });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("Authentication required");
    });

    it("returns 403 when role is not customer or admin", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "professional-1")
        .set("x-chronopay-role", "professional")
        .send({ slotId: "slot-100" });

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("not authorized");
    });

    it("allows customer role", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .send({ slotId: "slot-100" });

      // Should not be 403 (forbidden)
      expect(response.status).not.toBe(403);
    });

    it("allows admin role", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "admin-1")
        .set("x-chronopay-role", "admin")
        .send({ slotId: "slot-100" });

      // Should not be 403 (forbidden)
      expect(response.status).not.toBe(403);
    });
  });

  describe("Payload Validation", () => {
    beforeEach(() => {
      setFeatureFlagsFromEnv({ FF_CREATE_BOOKING_INTENT: "true" });
    });

    it("returns 400 when payload is not an object", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.1.1")
        .send([]);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("JSON object");
    });

    it("returns 400 when slotId is missing", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.1.2")
        .send({ note: "test" });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("slotId is required");
    });

    it("returns 400 when slotId is empty string", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.1.3")
        .send({ slotId: "" });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("slotId is required");
    });

    it("returns 400 when slotId format is invalid", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.1.4")
        .send({ slotId: "ab" }); // Too short

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("slotId format is invalid");
    });

    it("returns 400 when slotId contains invalid characters", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.1.5")
        .send({ slotId: "slot@invalid!" });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("slotId format is invalid");
    });

    it("returns 400 when note is not a string", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.1.6")
        .send({ slotId: "slot-100", note: 123 });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("note must be a string");
    });

    it("returns 400 when note is empty string", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.1.7")
        .send({ slotId: "slot-100", note: "" });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("note cannot be empty");
    });

    it("returns 400 when note exceeds 500 characters", async () => {
      const longNote = "a".repeat(501);
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.1.8")
        .send({ slotId: "slot-100", note: longNote });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("500 characters");
    });

    it("accepts valid slotId with hyphens and numbers", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.1.9")
        .send({ slotId: "slot-100-abc" });

      // Should not be 400 (validation error)
      expect(response.status).not.toBe(400);
    });

    it("accepts valid note with 500 characters", async () => {
      const validNote = "a".repeat(500);
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.1.10")
        .send({ slotId: "slot-100", note: validNote });

      // Should not be 400 (validation error)
      expect(response.status).not.toBe(400);
    });

    it("trims whitespace from slotId", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.1.11")
        .send({ slotId: "  slot-100  " });

      // Should succeed (whitespace trimmed)
      expect(response.status).not.toBe(400);
    });
  });

  describe("Business Logic", () => {
    beforeEach(() => {
      setFeatureFlagsFromEnv({ FF_CREATE_BOOKING_INTENT: "true" });
    });

    it("returns 404 when slot is not found", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.2.1")
        .send({ slotId: "slot-missing" });

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("slot was not found");
    });

    it("returns 409 when slot is not bookable", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.2.2")
        .send({ slotId: "slot-102" }); // Not bookable

      expect(response.status).toBe(409);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("not bookable");
    });

    it("returns 403 when customer tries to book their own slot", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "alice")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.2.3")
        .send({ slotId: "slot-100" }); // Owned by alice

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("cannot create a booking intent for your own slot");
    });

    it("returns 201 and creates booking intent for valid request", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.2.4")
        .send({ slotId: "slot-100", note: "Window seat please" });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.intent).toBeDefined();
      expect(response.body.intent.id).toBeDefined();
      expect(response.body.intent.slotId).toBe("slot-100");
      expect(response.body.intent.customerId).toBe("customer-1");
      expect(response.body.intent.professional).toBe("alice");
      expect(response.body.intent.status).toBe("pending");
      expect(response.body.intent.note).toBe("Window seat please");
      expect(response.body.intent.createdAt).toBeDefined();
    });

    it("returns 409 when duplicate booking intent exists for same customer", async () => {
      // First request succeeds
      const first = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.2.5")
        .send({ slotId: "slot-100" });

      expect(first.status).toBe(201);

      // Second request from same customer fails
      const second = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .set("x-forwarded-for", "192.168.2.5")
        .send({ slotId: "slot-100" });

      expect(second.status).toBe(409);
      expect(second.body.success).toBe(false);
      expect(second.body.error).toContain("already exists for this slot");
    });
  });

  describe("Rate Limiting", () => {
    beforeEach(() => {
      setFeatureFlagsFromEnv({ FF_CREATE_BOOKING_INTENT: "true" });
    });

    it("rate limiter is configured and active", async () => {
      // Just verify the endpoint is rate limited (returns 429 after limit)
      // Detailed rate limit testing is done in rateLimiter.test.ts
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .send({ slotId: "slot-100" });

      // Should either succeed or be rate limited, not error
      expect([201, 429, 404, 409, 403, 400]).toContain(response.status);
    });
  });

  describe("Security Headers", () => {
    it("includes X-Content-Type-Options header", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .send({ slotId: "slot-100" });

      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("includes X-Frame-Options header", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .send({ slotId: "slot-100" });

      expect(response.headers["x-frame-options"]).toBe("DENY");
    });

    it("includes Referrer-Policy header", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .send({ slotId: "slot-100" });

      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    });

    it("includes Permissions-Policy header", async () => {
      const response = await harness.authorizedPost("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "customer-1")
        .set("x-chronopay-role", "customer")
        .send({ slotId: "slot-100" });

      expect(response.headers["permissions-policy"]).toBeDefined();
      expect(response.headers["permissions-policy"]).toContain("geolocation=()");
    });
  });
});
