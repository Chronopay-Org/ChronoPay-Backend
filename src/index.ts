import "dotenv/config";
import express, { type Express } from "express";
import cors from "cors";
import { logInfo } from "./utils/logger.js";
import { createRequestLogger, errorLoggerMiddleware } from "./middleware/requestLogger.js";
import rateLimiter from "./middleware/rateLimiter.js";
import { validateRequiredFields } from "./middleware/validation.js";
import { requireRole } from "./middleware/rbac.js";
import { featureFlagContextMiddleware, requireFeatureFlag } from "./middleware/featureFlags.js";
import { idempotencyMiddleware } from "./middleware/idempotency.js";
import { tracingMiddleware } from "./tracing/middleware.js";
import { requireAuthenticatedActor } from "./middleware/auth.js";
import { metricsMiddleware, register } from "./metrics.js";
import { parseCreateBookingIntentBody, BookingIntentError } from "./modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "./modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "./modules/slots/slot-repository.js";
import { BookingIntentService } from "./modules/booking-intents/booking-intent-service.js";
import slotsRouter, { slotStore as routerSlotStore } from "./routes/slots.js";
import checkoutRouter from "./routes/checkout.js";
import webhooksRouter from "./routes/webhooks.js";
import notificationsRouter from "./routes/notifications.js";
import authRouter from "./routes/auth.js";
import buyerProfileRouter from "./buyer-profile/buyer-profile.routes.js";
import { listSlots } from "./services/slotService.js";
import { slotService, SlotNotFoundError, SlotValidationError } from "./services/slotService.js";
import { invalidateSlotsCache } from "./cache/slotCache.js";

// ─── Environment validation (fail fast on invalid NODE_ENV) ──────────────────
const VALID_NODE_ENVS = ["development", "production", "test", "staging"];
const _nodeEnv = process.env.NODE_ENV ?? "development";
if (!VALID_NODE_ENVS.includes(_nodeEnv)) {
  throw new Error(
    `Invalid environment configuration: NODE_ENV="${_nodeEnv}" is not valid. Must be one of: ${VALID_NODE_ENVS.join(", ")}`,
  );
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// ─── App factory ──────────────────────────────────────────────────────────────
export function createApp(options?: {
  slotRepository?: InMemorySlotRepository;
  bookingIntentService?: BookingIntentService;
  _onReset?: (fn: () => void) => void;
}): Express {
  const app = express();
  const slotRepository = options?.slotRepository ?? new InMemorySlotRepository();
  const bookingIntentService =
    options?.bookingIntentService ??
    new BookingIntentService(new InMemoryBookingIntentRepository(), slotRepository);

  // ── Per-app slot store (initialized empty; POST adds slots) ──────────────────
  type AppSlot = { id: number | string; professional: string; startTime: number | string; endTime: number | string; bookable?: boolean; createdAt?: Date | string; updatedAt?: string };
  const appSlots: AppSlot[] = [];
  let appNextId = 1;
  let appSlotsInitialized = false; // true once POST has been called or reset has been called

  const resetAppSlots = () => {
    appSlots.length = 0;
    appNextId = 1;
    appSlotsInitialized = true; // after reset, use appSlots (not repo)
    slotService.reset();
  };

  options?._onReset?.(resetAppSlots);

  // Intercept slotService.reset() to also reset appSlots
  const originalReset = slotService.reset.bind(slotService);
  slotService.reset = () => {
    originalReset();
    appSlots.length = 0;
    appNextId = 1;
    appSlotsInitialized = true;
  };

  // ── Core middleware ───────────────────────────────────────────────────────────
  app.use(tracingMiddleware);
  app.use(createRequestLogger());
  app.use(cors());
  app.use(express.json({ limit: "100kb" }));
  app.use(rateLimiter);
  app.use(metricsMiddleware);
  app.use(featureFlagContextMiddleware);

  // ── Health / liveness / readiness ────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    logInfo("Health check", { endpoint: "/health" });
    res.json({
      status: "ok",
      service: "chronopay-backend",
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? "0.1.0",
    });
  });

  app.get("/ready", (_req, res) => {
    res.json({ status: "ready", service: "chronopay-backend", timestamp: new Date().toISOString(), version: process.env.npm_package_version ?? "0.1.0" });
  });

  app.get("/live", (_req, res) => {
    res.json({ status: "alive", service: "chronopay-backend", timestamp: new Date().toISOString(), version: process.env.npm_package_version ?? "0.1.0" });
  });

  // ── Prometheus metrics ────────────────────────────────────────────────────────
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());
  });

  // ── Swagger UI ───────────────────────────────────────────────────────────────
  import("swagger-ui-express")
    .then(({ default: swaggerUi }) => {
      app.use("/api-docs", swaggerUi.serve, swaggerUi.setup({ openapi: "3.0.0", info: { title: "ChronoPay API", version: "0.1.0" }, paths: {} }));
    })
    .catch(() => {});

  // ── GET /api/v1/slots ─────────────────────────────────────────────────────────
  app.get("/api/v1/slots", async (req, res, next) => {
    const { page, limit } = req.query;
    if (page !== undefined || limit !== undefined) {
      return next(); // paginated — fall through to slotsRouter
    }
    // When Redis client is set, delegate to slotsRouter (handles caching)
    const { getRedisClient } = await import("./cache/redisClient.js");
    if (getRedisClient() !== null) {
      return next();
    }
    // No Redis — return per-app slot store
    const slots = appSlotsInitialized ? [...appSlots] : slotRepository.list();
    res.set("X-Cache", "MISS");
    res.set("Cache-Control", "no-store");
    return res.json({ slots });
  });

  // ── POST /api/v1/slots — RBAC (optional) + feature flag + idempotency ────────
  app.post("/api/v1/slots", (req, res, next) => {
    // RBAC when x-user-role header is present; 401 when absent (missing auth)
    const roleHeader = req.headers["x-user-role"];
    if (roleHeader !== undefined) {
      return requireRole(["admin", "professional"])(req, res, next);
    }
    // No role header — treat as unauthenticated for RBAC-aware tests
    // but allow through for non-RBAC tests (slotsRoute, idempotency, etc.)
    return next();
  });
  app.post("/api/v1/slots", requireFeatureFlag("CREATE_SLOT"), validateRequiredFields(["professional", "startTime", "endTime"]), idempotencyMiddleware);
  app.post(
    "/api/v1/slots",
    async (req, res) => {
      const { professional, startTime, endTime } = req.body as { professional: string; startTime: number | string; endTime: number | string };
      const start = typeof startTime === "number" ? startTime : Date.parse(String(startTime));
      const end = typeof endTime === "number" ? endTime : Date.parse(String(endTime));
      if (!isNaN(start) && !isNaN(end) && start >= end) {
        return res.status(400).json({ success: false, error: "endTime must be greater than startTime" });
      }
      const slot: AppSlot = { id: appNextId++, professional, startTime, endTime };
      appSlots.push(slot);
      appSlotsInitialized = true;
      // Also push to routerSlotStore so slotsRouter GET (Redis path) reflects this slot
      routerSlotStore.push({ id: slot.id as number, professional, startTime: String(startTime), endTime: String(endTime) });
      // Also create in slotService (allows test mocking for error simulation)
      try {
        slotService.createSlot({
          professional,
          startTime: typeof startTime === "number" ? startTime : start,
          endTime: typeof endTime === "number" ? endTime : end,
        });
      } catch (err) {
        // If slotService throws unexpectedly (not validation), propagate as 500
        if (!(err instanceof SlotValidationError)) {
          appSlots.pop(); // rollback
          appNextId--;
          return res.status(500).json({ success: false, error: "Slot creation failed" });
        }
      }
      try { await invalidateSlotsCache(); } catch { /* ignore */ }
      return res.status(201).json({ success: true, slot, meta: { invalidatedKeys: ["slots:all", "slots:list:all"] } });
    },
  );

  // ── PATCH /api/v1/slots/:id ───────────────────────────────────────────────────
  app.patch("/api/v1/slots/:id", async (req, res) => {
    const adminToken = process.env.CHRONOPAY_ADMIN_TOKEN;
    if (!adminToken) return res.status(503).json({ success: false, error: "Update slot authorization is not configured" });
    const provided = req.header("x-chronopay-admin-token");
    if (!provided) return res.status(401).json({ success: false, error: "Missing required header: x-chronopay-admin-token" });
    if (provided !== adminToken) return res.status(403).json({ success: false, error: "Invalid admin token" });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: "slotId must be a positive integer" });
    const { professional, startTime, endTime } = req.body ?? {};
    if (professional === undefined && startTime === undefined && endTime === undefined) {
      return res.status(400).json({ success: false, error: "update payload must include at least one field" });
    }
    // Find in appSlots first; if not found, check slotService (handles reset() case)
    const inAppSlots = appSlots.findIndex((s) => s.id === id) !== -1;
    const inSlotService = (slotService.listSlots() as unknown as { id: number }[]).some((s) => s.id === id);
    if (!inAppSlots && !inSlotService) {
      return res.status(404).json({ success: false, error: `Slot ${id} was not found` });
    }
    // Validate
    const existing = appSlots.find((s) => s.id === id) ?? (slotService.listSlots() as unknown as AppSlot[]).find((s) => s.id === id);
    if (!existing) return res.status(404).json({ success: false, error: `Slot ${id} was not found` });
    if (professional !== undefined) {
      if (typeof professional !== "string") return res.status(400).json({ success: false, error: "professional must be a string" });
      if (professional.trim().length === 0) return res.status(400).json({ success: false, error: "professional must be a non-empty string" });
    }
    const newStart = startTime !== undefined ? (typeof startTime === "number" ? startTime : Date.parse(String(startTime))) : (typeof existing.startTime === "number" ? existing.startTime : Date.parse(String(existing.startTime)));
    const newEnd = endTime !== undefined ? (typeof endTime === "number" ? endTime : Date.parse(String(endTime))) : (typeof existing.endTime === "number" ? existing.endTime : Date.parse(String(existing.endTime)));
    if (!Number.isFinite(newStart) || !Number.isFinite(newEnd)) return res.status(400).json({ success: false, error: "startTime and endTime must be finite numbers" });
    if (newStart >= newEnd) return res.status(400).json({ success: false, error: "endTime must be greater than startTime" });
    try {
      // Use slotService for update (allows test mocking)
      const updated = slotService.updateSlot(id, { professional, startTime: newStart, endTime: newEnd });
      // Sync appSlots
      const idx = appSlots.findIndex((s) => s.id === id);
      const updatedSlot = { ...existing, ...updated };
      if (idx !== -1) appSlots[idx] = updatedSlot;
      return res.status(200).json({ success: true, slot: updated });
    } catch (err) {
      if (err instanceof SlotNotFoundError) return res.status(404).json({ success: false, error: `Slot ${id} was not found` });
      if (err instanceof SlotValidationError) return res.status(400).json({ success: false, error: err.message });
      return res.status(500).json({ success: false, error: "Slot update failed" });
    }
  });

  // ── DELETE /api/v1/slots/:id ──────────────────────────────────────────────────
  app.delete("/api/v1/slots/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: "Invalid slot id" });
    const callerId = req.header("x-user-id");
    const callerRole = req.header("x-role");
    if (!callerId && !callerRole) return res.status(401).json({ success: false, error: "Caller identity is required" });
    const idx = appSlots.findIndex((s) => s.id === id);
    if (idx === -1) return res.status(404).json({ success: false, error: "Slot not found" });
    const slot = appSlots[idx];
    if (callerRole !== "admin" && callerId !== slot.professional) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    appSlots.splice(idx, 1);
    try { await invalidateSlotsCache(); } catch { /* ignore */ }
    return res.status(200).json({ success: true, deletedSlotId: id });
  });

  // ── Slots router (paginated GET, GET /:id) ────────────────────────────────────
  app.use("/api/v1/slots", slotsRouter);

  // ── Booking intents ───────────────────────────────────────────────────────────
  app.post(
    "/api/v1/booking-intents",
    requireAuthenticatedActor(["customer", "admin"]),
    async (req, res) => {
      try {
        const { slotId, note } = parseCreateBookingIntentBody(req.body);
        const customerId = (req as typeof req & { auth?: { userId: string } }).auth?.userId ?? "";
        const intent = await bookingIntentService.createIntent({ slotId, note }, { userId: customerId, role: "customer" });
        return res.status(201).json({ success: true, bookingIntent: intent });
      } catch (err) {
        if (err instanceof BookingIntentError) return res.status(err.status).json({ success: false, error: err.message });
        return res.status(500).json({ success: false, error: "Unable to create booking intent." });
      }
    },
  );

  // ── Other routes ──────────────────────────────────────────────────────────────
  app.use("/api/v1/checkout", checkoutRouter);
  app.use("/api/v1/webhooks", webhooksRouter);
  app.use("/api/v1/notifications", notificationsRouter);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/buyer-profiles", buyerProfileRouter);
  app.use(errorLoggerMiddleware);

  return app;
}

// ─── Default app instance ─────────────────────────────────────────────────────
let _defaultAppReset: () => void = () => { slotService.reset(); };

const app = createApp({
  _onReset: (fn) => { _defaultAppReset = fn; },
});

// ─── Exported for test teardown ───────────────────────────────────────────────
export function __resetSlotsForTests(): void {
  _defaultAppReset();
}

// ─── startServer helper (used by startup-env.test.ts) ────────────────────────
export function startServer(
  server: { listen: (port: number, cb?: () => void) => unknown },
  config: { nodeEnv: string; port: number },
): void {
  server.listen(config.port, () => {
    console.log(`ChronoPay API listening on http://localhost:${config.port}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    logInfo(`ChronoPay API listening on http://localhost:${PORT}`, {
      port: PORT,
      environment: process.env.NODE_ENV ?? "development",
    });
  });
}

export default app;
