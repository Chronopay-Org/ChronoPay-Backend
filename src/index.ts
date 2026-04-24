import "dotenv/config";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import type { EnvConfig } from "./config/env.js";
import { loadEnvConfig } from "./config/env.js";
import { metricsMiddleware, register } from "./metrics.js";
import { errorHandler, notFoundMiddleware } from "./middleware/errorHandler.js";
import { requireFeatureFlag } from "./middleware/featureFlags.js";
import { authenticateToken, requireAuthenticatedActor } from "./middleware/auth.js";
import { requireInternalHmacAuth } from "./middleware/internalHmacAuth.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import {
  BookingIntentError,
  BookingIntentService,
  parseCreateBookingIntentBody,
} from "./modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "./modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "./modules/slots/slot-repository.js";
import checkoutRouter from "./routes/checkout.js";
import {
  findSlotById,
  listStoredSlots,
  removeSlotById,
  resetSlotStore,
} from "./routes/slots.js";
import {
  createRequestLogger,
  errorLoggerMiddleware,
} from "./middleware/requestLogger.js";
import slotsRouter from "./routes/slots.js";
import { processReminders } from "./scheduler/reminderWorker.js";
import { startScheduler } from "./scheduler/reminderScheduler.js";
import { tracingMiddleware } from "./tracing/middleware.js";
import { validateRequiredFields } from "./middleware/validation.js";
import { logInfo } from "./utils/logger.js";
import { InMemorySmsProvider, SmsNotificationService } from "./services/smsNotification.js";

const config = loadEnvConfig();

interface AppListener {
  listen(port: number, callback?: () => void): unknown;
}

export function createApp(options?: {
  slotRepository?: InMemorySlotRepository;
  bookingIntentService?: BookingIntentService;
}) {
  const app = express();
  const slotRepository = options?.slotRepository ?? new InMemorySlotRepository();
  const bookingIntentService =
    options?.bookingIntentService ??
    new BookingIntentService(new InMemoryBookingIntentRepository(), slotRepository);

  app.use(requestIdMiddleware);
  app.use(createRequestLogger());
  app.use(tracingMiddleware);
  app.use(cors());
  app.use(express.json({ limit: "100kb" }));
  app.use(metricsMiddleware);

  app.get("/metrics", async (_req, res) => {
    try {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (error) {
      res.status(500).end(error);
    }
  });

  function healthPayload(status: "ok" | "ready" | "alive") {
    return {
      status,
      service: "chronopay-backend",
      timestamp: new Date().toISOString(),
      version: process.env.SERVICE_VERSION ?? "0.1.0",
    };
  }

  app.get("/health", (_req, res) => res.json(healthPayload("ok")));
  app.get("/ready", (_req, res) => res.json(healthPayload("ready")));
  app.get("/live", (_req, res) => res.json(healthPayload("alive")));

  app.use("/api/v1/checkout", checkoutRouter);

  app.get("/api/v1/slots", authenticateToken, async (req, res, next) => {
    try {
      if (typeof req.query.page !== "undefined" || typeof req.query.limit !== "undefined") {
        const { listSlots } = await import("./services/slotService.js");
        const page = req.query.page ? Number(req.query.page) : 1;
        const limit = req.query.limit ? Number(req.query.limit) : 10;
        const paged = await listSlots({ page, limit });
        return res.json({ ...paged, slots: listStoredSlots() });
      }
      return next();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid pagination request";
      return res.status(400).json({ success: false, error: message });
    }
  });

  const slotsGuard = async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST" && req.method !== "GET") {
      return next();
    }

    await authenticateToken(req, res, () => undefined);
    if (res.headersSent) {
      return;
    }

    if (req.method !== "POST") {
      return next();
    }

    if (!req.header("authorization") && !process.env.JWT_SECRET) {
      const roleHeader = req.header("x-user-role");
      if (typeof roleHeader === "string" && roleHeader.trim().length === 0) {
        return res.status(401).json({
          success: false,
          error: "Missing required authentication header",
        });
      }
      if (roleHeader) {
        const role = roleHeader.trim().toLowerCase();
        const validRoles = new Set(["customer", "admin", "professional"]);
        if (!validRoles.has(role)) {
          return res.status(400).json({ success: false, error: "Invalid user role" });
        }
        if (role === "customer") {
          return res.status(403).json({ success: false, error: "Insufficient permissions" });
        }
      }
    }

    requireFeatureFlag("CREATE_SLOT")(req, res, () => undefined);
    if (res.headersSent) {
      return;
    }

    return validateRequiredFields(["professional", "startTime", "endTime"])(req, res, next);
  };

  app.use("/api/v1/slots", slotsGuard, slotsRouter);

  app.delete("/api/v1/slots/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: "Invalid slot id" });
    }
    const slot = findSlotById(id);
    if (!slot) {
      return res.status(404).json({ success: false, error: "Slot not found" });
    }
    const callerId = req.header("x-user-id");
    const callerRole = req.header("x-role");
    if (!callerId && callerRole !== "admin") {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }
    if (callerRole !== "admin" && callerId !== slot.professional) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
    removeSlotById(id);
    return res.status(200).json({ success: true, deletedSlotId: id });
  });

  const smsService = new SmsNotificationService(new InMemorySmsProvider(/^\+12000000000$/));
  app.post(
    "/api/v1/notifications/sms",
    validateRequiredFields(["to", "message"]),
    async (req, res) => {
      const result = await smsService.send(req.body.to, req.body.message);
      if (!result.success) {
        const status = result.error?.includes("Simulated failure") ? 502 : 400;
        return res.status(status).json(result);
      }
      return res.status(200).json(result);
    },
  );

  app.get("/api/v1/booking-intents", (_req, res) => {
    res.status(405).json({ success: false, error: "Method not allowed." });
  });

  app.post(
    "/api/v1/booking-intents",
    requireAuthenticatedActor(["customer", "admin"]),
    (req: Request, res: Response) => {
      try {
        const body = parseCreateBookingIntentBody(req.body);
        const actor = (req as Request & { auth: { userId: string; role: "customer" | "admin" } }).auth;
        const bookingIntent = bookingIntentService.createIntent(body, actor);
        return res.status(201).json({ success: true, bookingIntent });
      } catch (error) {
        if (error instanceof BookingIntentError) {
          return res.status(error.status).json({ success: false, error: error.message });
        }
        return res.status(500).json({ success: false, error: "Unable to create booking intent." });
      }
    },
  );

  app.post(
    "/internal/cron/reminders/trigger",
    requireInternalHmacAuth(),
    async (_req, res, next) => {
      try {
        await processReminders();
        res.status(202).json({ success: true, message: "Reminder run accepted" });
      } catch (error) {
        next(error);
      }
    },
  );

  app.use(errorLoggerMiddleware);
  app.use(notFoundMiddleware);
  app.use(errorHandler);

  return app;
}

export function startServer(app: AppListener, runtimeConfig: EnvConfig) {
  return app.listen(runtimeConfig.port, () => {
    console.log(`ChronoPay API listening on http://localhost:${runtimeConfig.port}`);
  });
}

export function __resetSlotsForTests() {
  resetSlotStore();
}

const app = createApp();

if (config.nodeEnv !== "test") {
  startScheduler();
  startServer(app, config);
  logInfo(`ChronoPay API listening on http://localhost:${config.port}`, { port: config.port });
}

export default app;
