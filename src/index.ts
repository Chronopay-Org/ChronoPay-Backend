import "dotenv/config";
import { loadEnvConfig, type EnvConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { startScheduler } from "./scheduler/reminderScheduler.js";
import { logInfo } from "./utils/logger.js";

const config: EnvConfig = loadEnvConfig();

const app = createApp({
  enableContentNegotiation: true,
  contentNegotiationExcludePaths: [
    // Add webhook paths here if needed in the future
    // e.g., "/api/v1/webhooks"
  ],
});

if (config.nodeEnv !== "test") {
  const PORT = config.port;
  startScheduler();

  app.listen(PORT, () => {
    logInfo(`ChronoPay API listening on http://localhost:${PORT}`, {
      port: PORT,
      environment: config.nodeEnv || "development",
    });
  });
}

export default app;
