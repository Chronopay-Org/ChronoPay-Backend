// @ts-nocheck
import { describe, it, expect, beforeEach } from "@jest/globals";
import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { registerWebhookRoutes, _resetProcessedTransactions } from "../routes/webhooks.js";

const SECRET = "test-webhook-secret";

const app = express();

// Capture raw body for HMAC verification (mirrors production setup)
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// The default-exported router no longer serves POST /settlements (#1307);
// registerWebhookRoutes is the single registration path for provider webhooks.
registerWebhookRoutes(app, { signingSecret: SECRET });

function sign(body) {
  return createHmac("sha256", SECRET).update(JSON.stringify(body)).digest("hex");
}

function validPayload() {
  return {
    eventType: "settlement_completed",
    transactionId: "txn-001",
    amount: 100,
    // Fresh timestamp: the /api/v1 webhook path rejects stale payloads (>5 min).
    timestamp: Date.now(),
  };
}

async function post(body) {
  return request(app)
    .post("/api/v1/webhooks/settlements")
    .set("x-webhook-signature", sign(body))
    .send(body);
}

beforeEach(() => {
  _resetProcessedTransactions();
  kycService.reset();
});

describe("POST /api/v1/webhooks/settlements", () => {
  it("accepts a valid settlement event", async () => {
    const res = await post(validPayload());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when eventType is missing", async () => {
    const { eventType: _, ...payload } = validPayload();
    const res = await post(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/eventType/);
  });

  it("returns 400 when transactionId is missing", async () => {
    const { transactionId: _, ...payload } = validPayload();
    const res = await post(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/transactionId/);
  });

  it("returns 400 for an invalid eventType", async () => {
    const res = await post({ ...validPayload(), eventType: "unknown_event" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid eventType/);
  });

  it("returns 400 when amount is zero", async () => {
    const res = await post({ ...validPayload(), amount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/);
  });

  // Idempotency: same transactionId twice

  it("returns 200 on a duplicate transactionId (exact replay)", async () => {
    const payload = validPayload();
    await post(payload);
    const second = await post(payload);
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
  });

  it("returns the original response body on duplicate transactionId", async () => {
    const payload = validPayload();
    const first = await post(payload);
    const second = await post(payload);
    expect(second.body).toEqual(first.body);
  });

  it("processes the event only once (no double-processing) for repeated transactionId", async () => {
    const payload = { ...validPayload(), transactionId: "txn-idempotent-only-once" };

    const first = await post(payload);
    const second = await post(payload);
    const third = await post(payload);

    // All must succeed without error
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    // All responses must be identical (served from store after first)
    expect(second.body).toEqual(first.body);
    expect(third.body).toEqual(first.body);
  });

  it("treats different transactionIds independently", async () => {
    const payloadA = { ...validPayload(), transactionId: "txn-A" };
    const payloadB = { ...validPayload(), transactionId: "txn-B" };

    const resA = await post(payloadA);
    const resB = await post(payloadB);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Duplicate A still works
    const resA2 = await post(payloadA);
    expect(resA2.status).toBe(200);
    expect(resA2.body).toEqual(resA.body);
  });

  it("duplicate with different eventType for same transactionId still returns 200 (dedup by txId)", async () => {
    const payload = validPayload();
    await post(payload);
    const second = await post({ ...payload, eventType: "settlement_failed" });
    // Idempotency key is transactionId; second call is treated as duplicate
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
  });
});

const kycPayload = (overrides = {}) => ({
  eventId: "kyc-evt-001",
  occurredAt: new Date().toISOString(),
  supplierId: "supplier-001",
  status: "verified",
  ...overrides,
});

describe("POST /webhooks/kyc", () => {
  it("accepts a valid KYC event", async () => {
    const res = await request(app).post("/webhooks/kyc").send(kycPayload());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when eventId is missing", async () => {
    const { eventId: _, ...payload } = kycPayload();
    const res = await request(app).post("/webhooks/kyc").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/eventId/);
  });

  it("returns 400 when occurredAt is missing", async () => {
    const { occurredAt: _, ...payload } = kycPayload();
    const res = await request(app).post("/webhooks/kyc").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/occurredAt/);
  });

  it("returns 403 for a payload older than 5 minutes", async () => {
    const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const res = await request(app)
      .post("/webhooks/kyc")
      .send(kycPayload({ occurredAt: stale }));
    expect(res.status).toBe(403);
  });

  it("returns the cached response on replay and does not re-grant the bootstrap", async () => {
    const payload = kycPayload();
    const first = await request(app).post("/webhooks/kyc").send(payload);
    const second = await request(app).post("/webhooks/kyc").send(payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(kycService.getBootstrapGrantCount(payload.supplierId)).toBe(1);
  });

  it("ignores a verified event older than the last applied rejected event", async () => {
    const rejectedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const verifiedAt = new Date(Date.now() - 120 * 1000).toISOString();

    await request(app)
      .post("/webhooks/kyc")
      .send(kycPayload({ eventId: "evt-rejected", status: "rejected", occurredAt: rejectedAt }));

    const res = await request(app)
      .post("/webhooks/kyc")
      .send(kycPayload({ eventId: "evt-verified", status: "verified", occurredAt: verifiedAt }));

    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe("stale");
    expect(kycService.getStatus("supplier-001")).toBe("rejected");
    expect(kycService.getBootstrapGrantCount("supplier-001")).toBe(0);
  });
});
