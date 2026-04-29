import { createApp } from "./app.js";
import { loadEnvConfig, type EnvConfig } from "./config/env.js";
import { logInfo } from "./utils/logger.js";

export function startServer(
  server: { listen: (port: number, callback?: () => void) => unknown },
  config: EnvConfig,
) {
  return server.listen(config.port, () => {
    console.log(`ChronoPay API listening on http://localhost:${config.port}`);
  });
}

const config = loadEnvConfig();
const app = createApp();

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    logInfo(`Server running on port ${PORT}`);
  });
}

export default app;
