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

// If you want to add global middleware (like timeout), do it in createApp in app.ts

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
}

const app = createApp();

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
