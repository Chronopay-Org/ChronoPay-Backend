// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import router, { _resetProcessedTransactions } from "../routes/webhooks.js";
import * as dispatchModule from "../webhooks/dispatch.js";
import { register } from "prom-client";

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

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

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

    const resA2 = await request(app).post("/webhooks/settlements").send(payloadA);
    expect(resA2.status).toBe(200);
    expect(resA2.body).toEqual(resA.body);
  });

  it("duplicate with different eventType for same transactionId still returns 200 (dedup by txId)", async () => {
    await request(app).post("/webhooks/settlements").send(validPayload);
    const second = await request(app)
      .post("/webhooks/settlements")
      .send({ ...validPayload, eventType: "settlement_failed" });
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
  });
});

describe("webhook delivery retries", () => {
  let fetchMock: jest.Mock;

  const mockResponse = (status: number, headers: Record<string, string> = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  });

  const totalAttempts = (): number => {
    const metric = register.getSingleMetric("webhook_deliver_attempts_total") as any;
    if (!metric) return 0;
    return metric.get().values.reduce((sum: number, v: any) => sum + v.value, 0);
  };

  const sendWebhook =
    dispatchModule.sendWebhook ??
    dispatchModule.dispatchWebhook ??
    dispatchModule.dispatch;

  beforeEach(() => {
    const metric = register.getSingleMetric("webhook_deliver_attempts_total") as any;
    if (metric) metric.reset();
    jest.useFakeTimers();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete (global as any).fetch;
  });

  it("retries 5tx with exponential backoff and succeeds on a later 2xx", async () => {
    const payload = { eventType: "settlement_completed", transactionId: "txn-001", amount: 100 };

    fetchMock
      .mockResolvedOnce(mockResponse(500))
      .mockResolvedOnce(mockResponse(500))
      .mockResolvedOnce(mockResponse(200));

    const timeoutSpy = jest.spyOn(global, "setTimeout");
    const delivery = sendWebhook("https://receiver.example/hook", payload);

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(totalAttempts()).toBe(1);

    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(totalAttempts()).toBe(2);

    await jest.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(totalAttempts()).toBe(3);

    await expect(delivery).resolves.toMatchObject({ success: true });

    const delays = timeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays.filter((delay) => typeof delay === "number")).toEqual([1000, 2000]);
  });

  it("exhausts 6 attempts and moves to DLQ when receiver keeps returning 500", async () => {
    fetchMock.mockResolved(mockResponse(500));

    const delivery = sendWebhook("https://receiver.example/hook", {});
    await jest.advanceTimersByTimeAsync(1_000_000);

    await expect(delivery).resolves.toMatchObject({ success: false, movedToDLQ: true });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(totalAttempts()).toBe(6);
  });

  it("succeeds immediately on a 2xx without retries", async () => {
    fetchMock.mockResolvedOnce(mockResponse(200));

    await expect(
      sendWebhook("https://receiver.example/hook", {})
    ).resolves.toMatchObject({ success: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(totalAttempts()).toBe(1);
  });

  it("honors Retry-After on 429 responses", async () => {
    fetchMock
      .mockResolvedOnce(mockResponse(429, { "Retry-After": "2" }))
      .mockResolvedOnce(mockResponse(200));

    const timeoutSpy = jest.spyOn(global, "setTimeout");
    const delivery = sendWebhook("https://receiver.example/hook", {});

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2000);
    await expect(delivery).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const delays = timeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays.filter((delay) => typeof delay === "number")).toEqual([2000]);
  });
});
