import { describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";
// @ts-expect-error - Auto-fixed by script
import router, { _resetProcessedTransactions } from "../routes/webhooks.js";

const app = express();
app.use(express.json());
app.use("/webhooks", router);

const validPayload = {
  eventType: "settlement_completed",
  transactionId: "txn-001",
  amount: 100,
  timestamp: 1700000000,
};

beforeEach(() => {
  _resetProcessedTransactions();
});

describe("POST /webhooks/settlements", () => {
  it("accepts a valid settlement event", async () => {
    const res = await request(app).post("/webhooks/settlements").send(validPayload);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when eventType is missing", async () => {
    const { eventType: _, ...payload } = validPayload;
    const res = await request(app).post("/webhooks/settlements").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/eventType/);
  });

  it("returns 400 when transactionId is missing", async () => {
    const { transactionId: _, ...payload } = validPayload;
    const res = await request(app).post("/webhooks/settlements").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/transactionId/);
  });

  it("returns 400 for an invalid eventType", async () => {
    const res = await request(app)
      .post("/webhooks/settlements")
      .send({ ...validPayload, eventType: "unknown_event" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid eventType/);
  });

  it("returns 400 when amount is zero", async () => {
    const res = await request(app)
      .post("/webhooks/settlements")
      .send({ ...validPayload, amount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/);
  });

  // Idempotency: same transactionId twice

  it("returns 200 on a duplicate transactionId (exact replay)", async () => {
    await request(app).post("/webhooks/settlements").send(validPayload);
    const second = await request(app).post("/webhooks/settlements").send(validPayload);
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
  });

  it("returns the original response body on duplicate transactionId", async () => {
    const first = await request(app).post("/webhooks/settlements").send(validPayload);
    const second = await request(app).post("/webhooks/settlements").send(validPayload);
    expect(second.body).toEqual(first.body);
  });

  it("processes the event only once (no double-processing) for repeated transactionId", async () => {
    const txId = "txn-idempotent-only-once";
    const payload = { ...validPayload, transactionId: txId };

    const first = await request(app).post("/webhooks/settlements").send(payload);
    const second = await request(app).post("/webhooks/settlements").send(payload);
    const third = await request(app).post("/webhooks/settlements").send(payload);

    // All must succeed without error
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    // All responses must be identical (served from store after first)
    expect(second.body).toEqual(first.body);
    expect(third.body).toEqual(first.body);
  });

  it("treats different transactionIds independently", async () => {
    const payloadA = { ...validPayload, transactionId: "txn-A" };
    const payloadB = { ...validPayload, transactionId: "txn-B" };

    const resA = await request(app).post("/webhooks/settlements").send(payloadA);
    const resB = await request(app).post("/webhooks/settlements").send(payloadB);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Duplicate A still works
    const resA2 = await request(app).post("/webhooks/settlements").send(payloadA);
    expect(resA2.status).toBe(200);
    expect(resA2.body).toEqual(resA.body);
  });

  it("duplicate with different eventType for same transactionId still returns 200 (dedup by txId)", async () => {
    await request(app).post("/webhooks/settlements").send(validPayload);
    const second = await request(app)
      .post("/webhooks/settlements")
      .send({ ...validPayload, eventType: "settlement_failed" });
    // Idempotency key is transactionId; second call is treated as duplicate
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
  });
});
