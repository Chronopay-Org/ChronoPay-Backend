import "dotenv/config";
import express from "express";
import cors from "cors";
import { logInfo } from "./utils/logger.js";

import {
  createRequestLogger,
  errorLoggerMiddleware,
} from "./middleware/requestLogger.js";

import { validateRequiredFields } from "./middleware/validation.js";
import rateLimiter from "./middleware/rateLimiter.js";

import {
  BookingIntentService,
} from "./modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "./modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "./modules/slots/slot-repository.js";

export function createApp() {
  const app = express();

  const slotRepository = new InMemorySlotRepository();
  const bookingIntentService = new BookingIntentService(
    new InMemoryBookingIntentRepository(),
    slotRepository
  );

  // Middlewares
  app.use(createRequestLogger());
  app.use(cors());
  app.use(express.json());

  // Health
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "chronopay-backend" });
  });

  // Get slots
  app.get("/api/v1/slots", (_req, res) => {
    res.json({ slots: slotRepository.list() });
  });

  // Create slot
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
    }
  );

  // Error middleware
  app.use(errorLoggerMiddleware);

  return app;
} // ✅ THIS WAS MISSING

// Start server
const app = createApp();

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    logInfo(`Server running on port ${PORT}`);
  });
}

export default app;