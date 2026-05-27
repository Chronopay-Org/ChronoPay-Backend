import "dotenv/config";
import { logInfo } from "./utils/logger.js";
import { loadEnvConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { register, metricsMiddleware } from "./metrics.js";
import { startScheduler } from "./scheduler/reminderScheduler.js";

const config = loadEnvConfig();

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

export default app;
