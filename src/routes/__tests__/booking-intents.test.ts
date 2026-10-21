import request from "supertest";
import { createApp } from "../../app.js";
import { setFeatureFlagsFromEnv } from "../../flags/service.js";
import { fraudReviewQueue } from "../../services/fraudReviewQueue.js";
import { signJwt } from "../../utils/jwt.js";
import { configService } from "../../config/config.service.js";

const CHALLENGE_SECRET = "route-challenge-secret-12345";
const CHALLENGE_ISSUER = "route-challenge-issuer";
const CHALLENGE_AUDIENCE = "route-challenge-audience";

/** A fresh MFA proof for `sub`, shaped like POST /auth/mfa/verify would issue. */
async function mfaProof(sub: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt({ sub, iat, mfa_at: iat }, CHALLENGE_SECRET, {
    expiresInSec: 3600,
    issuer: CHALLENGE_ISSUER,
    audience: CHALLENGE_AUDIENCE,
  });
}

describe("POST /api/v1/booking-intents", () => {
  const app = createApp({
    apiKey: "test-api-key",
  });

  const validUserId = "user-123";
  const validRole = "customer";
  // From DEFAULT_SLOTS in InMemorySlotRepository (uuid slot ids only)
  const validSlotId = "slot-11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    // Enable the flag by default for most tests
    process.env.FF_CREATE_BOOKING_INTENT = "true";
    setFeatureFlagsFromEnv(process.env);
  });

  afterEach(() => {
    // Clean up anti-fraud env so it cannot leak into other tests / apps.
    delete process.env.FRAUD_STEP_UP_MODE;
    delete process.env.FRAUD_STEP_UP_THRESHOLD;
    delete process.env.FRAUD_MAX_INTENTS;
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
          note: "Please be on time",
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.intent).toMatchObject({
        slotId: validSlotId,
        customerId: validUserId,
        status: "pending",
        note: "Please be on time",
      });
      expect(response.body.intent.id).toBeDefined();
    });

    it("should return 409 if slot is not bookable", async () => {
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .send({ slotId: "slot-33333333-3333-4333-8333-333333333333" }); // charlie, bookable: false

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        success: false,
        error: "Selected slot is not bookable.",
        message: "Selected slot is not bookable.",
        code: "CONFLICT",
        timestamp: expect.any(String),
      });
    });

    it("should return 409 if the slot was already reserved by another user", async () => {
      const occupiedSlot = "slot-22222222-2222-4222-8222-222222222222";
      // First creation reserves the slot
      const first = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .send({ slotId: occupiedSlot });
      expect(first.status).toBe(201);

      // Second creation for same slot (by anyone) is rejected
      const response = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "another-user")
        .set("x-chronopay-role", validRole)
        .send({ slotId: occupiedSlot });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        success: false,
        error: "Selected slot is not bookable.",
        message: "Selected slot is not bookable.",
        code: "CONFLICT",
        timestamp: expect.any(String),
      });
    });

    it("should return 403 if professional books their own slot", async () => {
      // Fresh app so slot-1111...1111 has not been reserved by the success test
      const freshApp = createApp({ apiKey: "test-api-key" });
      const response = await request(freshApp)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", "alice") // slot-1111...1111 belongs to alice
        .set("x-chronopay-role", "admin") // alice is admin here
        .send({ slotId: validSlotId });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        success: false,
        error: "You cannot create a booking intent for your own slot.",
        message: "You cannot create a booking intent for your own slot.",
        code: "FORBIDDEN",
        timestamp: expect.any(String),
      });
    });
  });

  describe("Anti-fraud step-up (issue #807)", () => {
    const DISPOSABLE_EMAIL = "attacker@tempmail.com";

    beforeEach(() => {
      fraudReviewQueue._reset();
    });

    it("blocks a high-velocity + disposable-email actor in challenge mode", async () => {
      const freshApp = createApp({ apiKey: "test-api-key" });

      // Five clean requests book/409 but never cross the threshold (score 0).
      for (let i = 0; i < 5; i += 1) {
        const res = await request(freshApp)
          .post("/api/v1/booking-intents")
          .set("x-chronopay-user-id", validUserId)
          .set("x-chronopay-role", validRole)
          .send({ slotId: validSlotId });
        expect([201, 409]).toContain(res.status);
      }

      // Sixth request: velocity signal (count > max) + disposable email -> score 2.
      const blocked = await request(freshApp)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .set("accept-language", "es")
        .send({ slotId: validSlotId, email: DISPOSABLE_EMAIL });

      expect(blocked.status).toBe(403);
      expect(blocked.body).toMatchObject({
        success: false,
        error: "Booking intent blocked due to security policies.",
        challengeRequired: true,
      });
      expect(typeof blocked.body.challengeToken).toBe("string");
      expect(blocked.body.reasonCodes).toEqual(
        expect.arrayContaining(["RATE_LIMIT_EXCEEDED", "INVALID_CONTACT_INFO"]),
      );
      // accept-language drives the localized message catalog.
      expect(blocked.body.messages).toEqual(expect.arrayContaining([expect.any(String)]));
    });

    it("quarantines the high-score intent instead of dropping it", async () => {
      process.env.FRAUD_STEP_UP_MODE = "quarantine";
      const freshApp = createApp({ apiKey: "test-api-key" });

      for (let i = 0; i < 5; i += 1) {
        await request(freshApp)
          .post("/api/v1/booking-intents")
          .set("x-chronopay-user-id", validUserId)
          .set("x-chronopay-role", validRole)
          .send({ slotId: validSlotId });
      }

      const blocked = await request(freshApp)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .send({ slotId: validSlotId, email: DISPOSABLE_EMAIL });

      expect(blocked.status).toBe(403);
      expect(typeof blocked.body.quarantineId).toBe("string");
      expect(blocked.body.challengeRequired).toBeUndefined();
    });

    it("lets a single borderline (review-tier) score through to creation", async () => {
      const freshApp = createApp({ apiKey: "test-api-key" });

      const res = await request(freshApp)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .send({ slotId: validSlotId, email: DISPOSABLE_EMAIL });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it("binds the HITL review item to the created intent's id (issue #1345)", async () => {
      const freshApp = createApp({ apiKey: "test-api-key" });

      const res = await request(freshApp)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .send({ slotId: validSlotId, email: DISPOSABLE_EMAIL });

      expect(res.status).toBe(201);
      expect(res.body.intent.id).toBeDefined();

      const pending = fraudReviewQueue.getPendingItems();
      expect(pending).toHaveLength(1);
      expect(pending[0].intentId).toBe(res.body.intent.id);
      expect(pending[0].intentId).not.toBe("temp-intent-id");
      expect(pending[0].score).toBeGreaterThan(0);
      expect(Array.isArray(pending[0].reasons)).toBe(true);
    });

    it("surfaces a user-agent/device-fingerprint mismatch as DEVICE_UNRECOGNIZED", async () => {
      process.env.FRAUD_STEP_UP_THRESHOLD = "1";
      const freshApp = createApp({ apiKey: "test-api-key" });

      const first = await request(freshApp)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .set("user-agent", "Mozilla/5.0 (Macintosh)")
        .set("x-device-fingerprint", "fp-device-1")
        .send({ slotId: validSlotId });
      expect(first.status).toBe(201);

      const second = await request(freshApp)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .set("user-agent", "Mozilla/5.0 (iPhone)")
        .set("x-device-fingerprint", "fp-device-1")
        .send({ slotId: validSlotId });

      expect(second.status).toBe(403);
      expect(second.body.reasonCodes).toContain("DEVICE_UNRECOGNIZED");
    });
  });

  describe("Anti-fraud step-up challenge token (issue #1345)", () => {
    const DISPOSABLE_EMAIL = "attacker@tempmail.com";

    const originalChallengeSecret = process.env.MFA_CHALLENGE_SECRET;
    const originalMfaIssuer = process.env.MFA_ISSUER;
    const originalJwtAudience = process.env.JWT_AUDIENCE;

    beforeAll(() => {
      process.env.MFA_CHALLENGE_SECRET = CHALLENGE_SECRET;
      process.env.MFA_ISSUER = CHALLENGE_ISSUER;
      process.env.JWT_AUDIENCE = CHALLENGE_AUDIENCE;
      configService.refresh();
    });

    afterAll(() => {
      delete process.env.MFA_CHALLENGE_SECRET;
      delete process.env.MFA_ISSUER;
      delete process.env.JWT_AUDIENCE;
      void originalChallengeSecret;
      void originalMfaIssuer;
      void originalJwtAudience;
      configService.refresh();
    });

    beforeEach(() => {
      fraudReviewQueue._reset();
    });

    /** Drives velocity to the block and returns the issued challenge token. */
    async function blockAndGetToken(app: ReturnType<typeof createApp>): Promise<string> {
      for (let i = 0; i < 5; i += 1) {
        await request(app)
          .post("/api/v1/booking-intents")
          .set("x-chronopay-user-id", validUserId)
          .set("x-chronopay-role", validRole)
          .send({ slotId: validSlotId });
      }
      const blocked = await request(app)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .send({ slotId: validSlotId, email: DISPOSABLE_EMAIL });
      expect(blocked.status).toBe(403);
      return blocked.body.challengeToken as string;
    }

    it("completes the step-up once and refuses to reuse the token", async () => {
      const freshApp = createApp({ apiKey: "test-api-key" });
      const token = await blockAndGetToken(freshApp);

      const retry = await request(freshApp)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .set("x-fraud-challenge", token)
        .set("x-chronopay-mfa", await mfaProof(validUserId))
        .send({ slotId: validSlotId, email: DISPOSABLE_EMAIL });

      // The wall lets the retried request through: the creation path is reached
      // and answers for itself (a booking already exists for this slot, which
      // is a normal outcome of the request now being unblocked).
      expect(retry.status).toBe(409);
      expect(retry.body.code).toBe("CONFLICT");

      const reuse = await request(freshApp)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .set("x-fraud-challenge", token)
        .set("x-chronopay-mfa", await mfaProof(validUserId))
        .send({ slotId: validSlotId, email: DISPOSABLE_EMAIL });

      expect(reuse.status).toBe(403);
      expect(reuse.body.error).toBe("Fraud challenge token is not valid.");
    });

    it("rejects a step-up retry without a fresh MFA proof", async () => {
      const freshApp = createApp({ apiKey: "test-api-key" });
      const token = await blockAndGetToken(freshApp);

      const retry = await request(freshApp)
        .post("/api/v1/booking-intents")
        .set("x-chronopay-user-id", validUserId)
        .set("x-chronopay-role", validRole)
        .set("x-fraud-challenge", token)
        .send({ slotId: validSlotId, email: DISPOSABLE_EMAIL });

      expect(retry.status).toBe(401);
      expect(retry.body.error).toBe("Missing MFA challenge");
    });
  });
});
