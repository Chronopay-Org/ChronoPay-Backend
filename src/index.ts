import "dotenv/config";
import express from "express";
import cors from "cors";
import { logInfo } from "./utils/logger.js";
import {
  createRequestLogger,
  errorLoggerMiddleware,
} from "./middleware/requestLogger.js";
import rateLimiter from "./middleware/rateLimiter.js";
import { validateRequiredFields } from "./middleware/validation.js";

import { InMemoryBookingIntentRepository } from "./modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "./modules/slots/slot-repository.js";
import { BookingIntentService } from "./modules/booking-intents/booking-intent-service.js";

const PORT = process.env.PORT || 3000;

export function createApp(options?: {
  slotRepository?: InMemorySlotRepository;
  bookingIntentService?: BookingIntentService;
}) {
  const app = express();
  const slotRepository = options?.slotRepository ?? new InMemorySlotRepository();
  const bookingIntentService =
    options?.bookingIntentService ??
    new BookingIntentService(new InMemoryBookingIntentRepository(), slotRepository);

  // Request logging middleware (must be first)
  app.use(createRequestLogger());
  
  app.use(cors());
  app.use(express.json({ limit: "100kb" }));
  app.use(rateLimiter);

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
    (req, res) => {
      const { professional, startTime, endTime } = req.body;

      res.status(201).json({
        success: true,
        slot: {
          id: Date.now(),
          professional,
          startTime,
          endTime,
        },
      });
    },
  );

  // Error handling middleware (must be last)
  app.use(errorLoggerMiddleware);
  
  return app;
}

const app = createApp();

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    logInfo(`ChronoPay API listening on http://localhost:${PORT}`, {
      port: PORT,
      environment: process.env.NODE_ENV || "development",
    });
  });
}

export default app;
