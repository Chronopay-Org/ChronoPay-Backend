import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { createNotificationsRouter } from "../notifications.js";
import {
  SmsNotificationService,
  type SmsProvider,
  type SmsSendResult,
} from "../../services/smsNotification.js";

describe("notifications routes", () => {
  describe("POST /api/v1/notifications/sms", () => {
    it("returns 502 on provider failure", async () => {
      const failingProvider: SmsProvider = {
        name: "failing-provider",
        async sendSms(_to: string, _message: string): Promise<SmsSendResult> {
          return {
            success: false,
            error: "Provider unavailable",
            statusCode: 503,
          };
        },
      };

      const smsService = new SmsNotificationService(failingProvider);
      const router = createNotificationsRouter(smsService);

      const app = express();
      app.use(express.json());
      app.use("/api/v1/notifications", router);

      // Mock middleware
      app.use((req, res, next) => {
        req.auth = { userId: "user-123", role: "customer" };
        next();
      });

      const res = await request(app)
        .post("/api/v1/notifications/sms")
        .send({
          to: "+12025550123",
          message: "Test message",
        });

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        success: false,
        error: "Provider unavailable",
      });
    });

    it("returns 200 with provider and providerMessageId on success", async () => {
      const successProvider: SmsProvider = {
        name: "success-provider",
        async sendSms(_to: string, _message: string): Promise<SmsSendResult> {
          return {
            success: true,
            providerMessageId: "msg-abc-123",
          };
        },
      };

      const smsService = new SmsNotificationService(successProvider);
      const router = createNotificationsRouter(smsService);

      const app = express();
      app.use(express.json());
      app.use("/api/v1/notifications", router);

      // Mock middleware
      app.use((req, res, next) => {
        req.auth = { userId: "user-123", role: "customer" };
        next();
      });

      const res = await request(app)
        .post("/api/v1/notifications/sms")
        .send({
          to: "+12025550123",
          message: "Test message",
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        provider: "success-provider",
        providerMessageId: "msg-abc-123",
      });
    });

    it("returns 400 for missing recipient", async () => {
      const smsService = new SmsNotificationService({
        name: "test-provider",
        async sendSms(): Promise<SmsSendResult> {
          return { success: true, providerMessageId: "msg-123" };
        },
      });
      const router = createNotificationsRouter(smsService);

      const app = express();
      app.use(express.json());
      app.use("/api/v1/notifications", router);

      // Mock middleware
      app.use((req, res, next) => {
        req.auth = { userId: "user-123", role: "customer" };
        next();
      });

      const res = await request(app)
        .post("/api/v1/notifications/sms")
        .send({
          message: "Test message",
        });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: "Recipient number is required",
      });
    });

    it("returns 400 for missing message", async () => {
      const smsService = new SmsNotificationService({
        name: "test-provider",
        async sendSms(): Promise<SmsSendResult> {
          return { success: true, providerMessageId: "msg-123" };
        },
      });
      const router = createNotificationsRouter(smsService);

      const app = express();
      app.use(express.json());
      app.use("/api/v1/notifications", router);

      // Mock middleware
      app.use((req, res, next) => {
        req.auth = { userId: "user-123", role: "customer" };
        next();
      });

      const res = await request(app)
        .post("/api/v1/notifications/sms")
        .send({
          to: "+12025550123",
        });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: "SMS message is required",
      });
    });

    it("returns 400 for invalid phone format", async () => {
      const smsService = new SmsNotificationService({
        name: "test-provider",
        async sendSms(): Promise<SmsSendResult> {
          return { success: true, providerMessageId: "msg-123" };
        },
      });
      const router = createNotificationsRouter(smsService);

      const app = express();
      app.use(express.json());
      app.use("/api/v1/notifications", router);

      // Mock middleware
      app.use((req, res, next) => {
        req.auth = { userId: "user-123", role: "customer" };
        next();
      });

      const res = await request(app)
        .post("/api/v1/notifications/sms")
        .send({
          to: "12025550123",
          message: "Test message",
        });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: expect.stringContaining("E.164 format"),
      });
    });
  });
});
