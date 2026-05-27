import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { logInfo } from "./utils/logger.js";
import {
  createRequestLogger,
  errorLoggerMiddleware,
} from "./middleware/requestLogger.js";
import { validateRequiredFields } from "./middleware/validation.js";
import rateLimiter from "./middleware/rateLimiter.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";

import { loadEnvConfig, type EnvConfig } from "./config/env.js";
import {
  requireAuthenticatedActor,
  type AuthenticatedRequest,
} from "./middleware/auth.js";
import {
  BookingIntentError,
  BookingIntentService,
  parseCreateBookingIntentBody,
} from "./modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "./modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "./modules/slots/slot-repository.js";

interface AppListener {
  listen(port: number, callback?: () => void): unknown;
}

export function createApp(options?: {
  slotRepository?: InMemorySlotRepository;
  bookingIntentService?: BookingIntentService;
  settlementWebhookSecret?: string;
}) {
  const app = express();
  const slotRepository = options?.slotRepository ?? new InMemorySlotRepository();
  const bookingIntentService =
    options?.bookingIntentService ??
    new BookingIntentService(new InMemoryBookingIntentRepository(), slotRepository);

  function captureRawBody(req: Request, _res: Response, buf: Buffer) {
    if (Buffer.isBuffer(buf) && buf.length > 0) {
      req.rawBody = buf;
    }
  }

  // Request logging middleware (must be first)
  app.use(createRequestLogger());
  
  app.use(cors());
  app.use(express.json({ limit: "100kb", verify: captureRawBody }));

  registerWebhookRoutes(app, {
    signingSecret:
      options?.settlementWebhookSecret ?? process.env.SETTLEMENTS_WEBHOOK_SECRET,
  });

  app.get("/health", (_req, res) => {
    const healthStatus = { status: "ok", service: "chronopay-backend" };
    logInfo("Health check endpoint called", { endpoint: "/health" });
    res.json(healthStatus);
  });

  app.get("/api/v1/slots", (_req, res) => {
    logInfo("Slots endpoint called", { endpoint: "/api/v1/slots" });
    res.json({ slots: slotRepository.list() });
  });

  app.post(
    "/api/v1/slots",
    validateRequiredFields(["professional", "startTime", "endTime"]),
    async (req, res) => {
      const { professional, startTime, endTime } = req.body;

      const slot = {
        id: Date.now(),
        professional,
        startTime,
        endTime,
      };

      res.status(201).json({
        success: true,
        slot,
      });
    },
  );

  // Error handling middleware (must be last)
  app.use(errorLoggerMiddleware);

  return app;
}

const app = createApp();

if (process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logInfo(`ChronoPay API listening on http://localhost:${PORT}`, {
      port: PORT,
      environment: process.env.NODE_ENV || "development",
    });
  });
}

export default app;
