import { createApp } from "./app.js";
import type { EnvConfig } from "./config/env.js";

// If you want to add global middleware (like timeout), do it in createApp in app.ts

export function startServer(
  server: { listen: (port: number, callback?: () => void) => unknown },
  config: EnvConfig,
) {
  return server.listen(config.port, () => {
    console.log(`ChronoPay API listening on http://localhost:${config.port}`);
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
