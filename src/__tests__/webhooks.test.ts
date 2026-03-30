import request from "supertest";
import app from "../index.js";

describe("POST /api/v1/webhooks/settlements", () => {
  const validPayload = {
    eventType: "settlement_completed",
    transactionId: "tx_abc123",
    amount: 100.5,
    timestamp: 1711324800000,
  };

  it("should accept valid settlement event", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send(validPayload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.received).toEqual(validPayload);
  });

  it("should accept settlement_initiated event", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send({ ...validPayload, eventType: "settlement_initiated" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should accept settlement_failed event", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send({ ...validPayload, eventType: "settlement_failed" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("should reject missing eventType", async () => {
    const { eventType, ...payload } = validPayload;
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("eventType");
  });

  it("should reject missing transactionId", async () => {
    const { transactionId, ...payload } = validPayload;
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("transactionId");
  });

  it("should reject missing amount", async () => {
    const { amount, ...payload } = validPayload;
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("amount");
  });

  it("should reject missing timestamp", async () => {
    const { timestamp, ...payload } = validPayload;
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("timestamp");
  });

  it("should reject invalid eventType", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send({ ...validPayload, eventType: "invalid_event" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid eventType");
  });

  it("should reject non-positive amount", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send({ ...validPayload, amount: 0 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid amount");
  });

  it("should reject negative amount", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send({ ...validPayload, amount: -50 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid amount");
  });

  it("should reject non-numeric amount", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send({ ...validPayload, amount: "100" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid amount");
  });

  it("should reject non-positive timestamp", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send({ ...validPayload, timestamp: 0 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid timestamp");
  });

  it("should reject negative timestamp", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send({ ...validPayload, timestamp: -1000 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid timestamp");
  });

  it("should reject empty request body", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/settlements")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
