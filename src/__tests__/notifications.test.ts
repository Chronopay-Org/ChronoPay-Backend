import express from "express";
import request from "supertest";
import { createNotificationsRouter } from "../routes/notifications.js";
import { InMemorySmsProvider, SmsNotificationService } from "../services/smsNotification.js";
import { getFeatureFlagAccessor, setFeatureFlagsFromEnv } from "../flags/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createApp({
  smsProvider,
  flagEnabled = true,
}: {
  smsProvider?: InMemorySmsProvider;
  flagEnabled?: boolean;
} = {}) {
  setFeatureFlagsFromEnv({
    FF_SMS_NOTIFICATIONS: flagEnabled ? "true" : "false",
  });

  const app = express();
  app.use(express.json());

  // Mount feature flag context middleware so requireFeatureFlag can read flags
  app.use((req, _res, next) => {
    (req as any).flags = getFeatureFlagAccessor();
    next();
  });

  const provider = smsProvider ?? new InMemorySmsProvider();
  const service = new SmsNotificationService(provider);
  app.use("/api/v1/notifications", createNotificationsRouter(service));

  return { app, provider };
}

const authHeaders = {
  "x-chronopay-user-id": "user-1",
  "x-chronopay-role": "customer",
};

const validPayload = {
  to: "+12025550123",
  message: "Your appointment is confirmed.",
};

// ─── Authentication ──────────────────────────────────────────────────────────

describe("POST /api/v1/notifications/sms — auth", () => {
  it("returns 401 when no auth headers are provided", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/api/v1/notifications/sms")
      .send(validPayload);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 403 when role is not authorized", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/api/v1/notifications/sms")
      .set("x-chronopay-user-id", "user-1")
      .set("x-chronopay-role", "professional")
      .send(validPayload);
    expect(res.status).toBe(403);
  });
});

// ─── Feature flag ────────────────────────────────────────────────────────────

describe("POST /api/v1/notifications/sms — feature flag", () => {
  it("returns 503 when SMS_NOTIFICATIONS is disabled", async () => {
    const { app } = createApp({ flagEnabled: false });
    const res = await request(app)
      .post("/api/v1/notifications/sms")
      .set(authHeaders)
      .send(validPayload);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("FEATURE_DISABLED");
  });
});

// ─── Input validation ────────────────────────────────────────────────────────

describe("POST /api/v1/notifications/sms — validation", () => {
  it("returns 400 when to is missing", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/api/v1/notifications/sms")
      .set(authHeaders)
      .send({ message: "hello" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it("returns 400 when message is missing", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/api/v1/notifications/sms")
      .set(authHeaders)
      .send({ to: "+12025550123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it("returns 400 when to is not E.164", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/api/v1/notifications/sms")
      .set(authHeaders)
      .send({ to: "not-a-phone", message: "hello" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/E\.164/i);
  });

  it("returns 400 when to is a local number without +", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/api/v1/notifications/sms")
      .set(authHeaders)
      .send({ to: "2025550123", message: "hello" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/E\.164/i);
  });
});

// ─── Successful send ─────────────────────────────────────────────────────────

describe("POST /api/v1/notifications/sms — success", () => {
  it("returns 200 on successful send", async () => {
    const { app } = createApp();
    const res = await request(app)
      .post("/api/v1/notifications/sms")
      .set(authHeaders)
      .send(validPayload);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.provider).toBe("in-memory");
    expect(res.body.providerMessageId).toBeDefined();
  });
});

// ─── Provider failure ────────────────────────────────────────────────────────

describe("POST /api/v1/notifications/sms — provider failure", () => {
  it("returns 502 when the provider fails", async () => {
    const failProvider = new InMemorySmsProvider(/.*/);
    const { app } = createApp({ smsProvider: failProvider });
    const res = await request(app)
      .post("/api/v1/notifications/sms")
      .set(authHeaders)
      .send(validPayload);
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });
});

// ─── Server error ──────────────────────────────────────────────────────────

class ThrowingSmsService {
  async send() {
    throw new Error("Unexpected failure");
  }
}

describe("POST /api/v1/notifications/sms — server error", () => {
  it("returns 500 when the service throws unexpectedly", () => {
    setFeatureFlagsFromEnv({ FF_SMS_NOTIFICATIONS: "true" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).flags = getFeatureFlagAccessor();
      next();
    });
    app.use("/api/v1/notifications", createNotificationsRouter(new ThrowingSmsService() as any));
    return request(app)
      .post("/api/v1/notifications/sms")
      .set(authHeaders)
      .send(validPayload)
      .expect(500)
      .expect((res) => {
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe("Internal server error");
      });
  });
});
