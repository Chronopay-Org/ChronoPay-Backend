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
import { logInfo } from "./utils/logger.js";
import { loadEnvConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { register, metricsMiddleware } from "./metrics.js";
import { startScheduler } from "./scheduler/reminderScheduler.js";

const config = loadEnvConfig();

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
const app = createApp({
  enableDocs: true,
  enableTestRoutes: config.nodeEnv !== "production"
});

// Add metrics middleware
app.use(metricsMiddleware);

/**
 * @api {get} /metrics Get Prometheus metrics
 */
app.get("/metrics", async (_req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err instanceof Error ? err.message : String(err));
  }
});

/**
 * Start the server
 */
export function startServer(appInstance: any, configInstance: any) {
  const PORT = configInstance.port || 3001;
  return appInstance.listen(PORT, () => {
    logInfo(`ChronoPay API listening on http://localhost:${PORT}`, {
      port: PORT,
      environment: configInstance.nodeEnv,
    });
  });
}

if (config.nodeEnv !== "test") {
  startScheduler();
  startServer(app, config);
}

// For compatibility with tests
export { createApp };
import { resetSlotStore } from "./routes/slots.js";
export function __resetSlotsForTests() {
  resetSlotStore();
}

async function shutdownWithTimeout(): Promise<void> {
  let forceExit = false;
  const timer = setTimeout(() => {
    forceExit = true;
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await gracefulShutdown();
  } finally {
    clearTimeout(timer);
    if (!forceExit) {
      process.exit(0);
    }
  }
}

if (process.env.NODE_ENV !== "test") {
  const { createApp } = await import("./app.js");
  const config = loadEnvConfig();
  const app = createApp();
  server = createServer(app);

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    activeRequests.add(req);
    const cleanup = () => activeRequests.delete(req);
    res.on("finish", cleanup);
    res.on("close", cleanup);
  });

  server.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });

  const handleSignal = () => {
    if (!isShuttingDown) {
      void shutdownWithTimeout();
    }
  };

  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);
}

export default server;
