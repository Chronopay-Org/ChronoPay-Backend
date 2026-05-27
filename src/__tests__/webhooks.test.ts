import { createHmac } from "node:crypto";
import request from "supertest";
import { createApp } from "../index.js";

const webhookSecret = "test-webhook-secret";
const signatureHeader = "x-webhook-signature";
const endpoint = "/api/v1/webhooks/settlements";

function signBody(body: string) {
  return `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
}

function signedRequest(app: ReturnType<typeof createApp>, body: string) {
  return request(app)
    .post(endpoint)
    .set("Content-Type", "application/json")
    .set(signatureHeader, signBody(body))
    .send(body);
}

function makeBody(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe("POST /api/v1/webhooks/settlements", () => {
  const app = createApp({ settlementWebhookSecret: webhookSecret });
  const validPayload = {
    eventType: "settlement_completed",
    transactionId: "tx_abc123",
    amount: 100.5,
    timestamp: Date.now(),
  };

  it("should accept valid settlement event", async () => {
    const body = makeBody(validPayload);
    const res = await signedRequest(app, body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.received).toEqual(validPayload);
  });

  it("should accept settlement_initiated event", async () => {
    const body = makeBody({ ...validPayload, eventType: "settlement_initiated" });
    const res = await signedRequest(app, body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should accept settlement_failed event", async () => {
    const body = makeBody({ ...validPayload, eventType: "settlement_failed" });
    const res = await signedRequest(app, body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should reject missing signature header", async () => {
    const body = makeBody(validPayload);
    const res = await request(app)
      .post(endpoint)
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Missing webhook signature");
  });

  it("should reject invalid signature", async () => {
    const body = makeBody(validPayload);
    const res = await request(app)
      .post(endpoint)
      .set("Content-Type", "application/json")
      .set(signatureHeader, "sha256=deadbeef")
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid webhook signature");
  });

  it("should reject stale replayed payload", async () => {
    const body = makeBody({ ...validPayload, timestamp: Date.now() - 10 * 60 * 1000 });
    const res = await signedRequest(app, body);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Rejected stale or future webhook payload");
  });

  it("should reject missing eventType", async () => {
    const { eventType, ...payload } = validPayload;
    const body = makeBody(payload);
    const res = await signedRequest(app, body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("eventType");
  });

  it("should reject missing transactionId", async () => {
    const { transactionId, ...payload } = validPayload;
    const body = makeBody(payload);
    const res = await signedRequest(app, body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("transactionId");
  });

  it("should reject missing amount", async () => {
    const { amount, ...payload } = validPayload;
    const body = makeBody(payload);
    const res = await signedRequest(app, body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("amount");
  });

  it("should reject missing timestamp", async () => {
    const { timestamp, ...payload } = validPayload;
    const body = makeBody(payload);
    const res = await signedRequest(app, body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("timestamp");
  });

  it("should reject invalid eventType", async () => {
    const body = makeBody({ ...validPayload, eventType: "invalid_event" });
    const res = await signedRequest(app, body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid eventType");
  });

  it("should reject non-positive amount", async () => {
    const body = makeBody({ ...validPayload, amount: 0 });
    const res = await signedRequest(app, body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid amount");
  });

  it("should reject negative amount", async () => {
    const body = makeBody({ ...validPayload, amount: -50 });
    const res = await signedRequest(app, body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid amount");
  });

  it("should reject non-numeric amount", async () => {
    const body = makeBody({ ...validPayload, amount: "100" });
    const res = await signedRequest(app, body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid amount");
  });

  it("should reject non-positive timestamp", async () => {
    const body = makeBody({ ...validPayload, timestamp: 0 });
    const res = await signedRequest(app, body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid timestamp");
  });

  it("should reject negative timestamp", async () => {
    const body = makeBody({ ...validPayload, timestamp: -1000 });
    const res = await signedRequest(app, body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid timestamp");
  });

  it("should reject empty request body", async () => {
    const body = makeBody({});
    const res = await signedRequest(app, body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
