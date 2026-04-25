export { createApp } from "./app.js";
export { resetSlotStore as __resetSlotsForTests } from "./routes/slots.js";
import { createApp } from "./app.js";
import { loadEnvConfig, type EnvConfig } from "./config/env.js";

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

if (config.nodeEnv !== "test") {
  startServer(app, config);
}

export default app;
