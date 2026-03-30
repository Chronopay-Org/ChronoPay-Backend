import request from "supertest";
import app from "../index.js";
import {
  InMemorySmsProvider,
  SmsNotificationService,
} from "../services/smsNotification.js";

describe("SmsNotificationService", () => {
  const provider = new InMemorySmsProvider();
  const service = new SmsNotificationService(provider);

  it("should send valid SMS", async () => {
    const result = await service.send("+12025550123", "Hello chronopay");
    expect(result.success).toBe(true);
    expect(result.provider).toBe("in-memory");
    expect(result.providerMessageId).toBeDefined();
  });

  it("should reject invalid phone format", async () => {
    const result = await service.send("2025550123", "hello");
    expect(result.success).toBe(false);
    expect(result.error).toContain("E.164 format");
  });

  it("should reject empty payload", async () => {
    const result = await service.send("+12025550123", "");
    expect(result.success).toBe(false);
    expect(result.error).toBe("SMS message is required");
  });

  it("should reject too-long messages", async () => {
    const longMessage = "x".repeat(1700);
    const result = await service.send("+12025550123", longMessage);
    expect(result.success).toBe(false);
    expect(result.error).toContain("exceeds max length");
  });

  it("should propagate provider failure result", async () => {
    const failingProvider = new InMemorySmsProvider(/^\+12000000000$/);
    const service2 = new SmsNotificationService(failingProvider);
    const result = await service2.send("+12000000000", "test");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Simulated failure");
  });

  it("should convert provider exception to failure result", async () => {
    const service3 = new SmsNotificationService(provider);
    const result = await service3.send("+12025550123", "__throw__");

    expect(result.success).toBe(false);
    expect(result.error).toContain("SMS provider exception");
  });
});

describe("SMS notification API", () => {
  it("should send SMS successfully via API", async () => {
    const res = await request(app).post("/api/v1/notifications/sms").send({
      to: "+12025550123",
      message: "Hi",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.provider).toBe("in-memory");
  });

  it("should return 400 from required field validator", async () => {
    const res = await request(app).post("/api/v1/notifications/sms").send({
      to: "+12025550123",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("should return 502 when provider returns failure", async () => {
    // Use the magic number that InMemorySmsProvider fails on
    const res = await request(app).post("/api/v1/notifications/sms").send({
      to: "+12000000000",
      message: "Fail this",
    });

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Simulated failure");
  });
});
