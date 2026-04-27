export { createApp } from "./app.js";
export { resetSlotStore as __resetSlotsForTests } from "./routes/slots.js";
import { createApp } from "./app.js";
import { loadEnvConfig, type EnvConfig } from "./config/env.js";

// If you want to add global middleware (like timeout), do it in createApp in app.js

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

// Error handler (must be last)
// If not already in createApp, add: app.use(errorHandler);

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
export { createApp };