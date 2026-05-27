import { createServer, type Server } from "http";
import { createApp } from "./app.js";
import { loadEnvConfig, type EnvConfig } from "./config/env.js";
import { stopScheduler } from "./scheduler/reminderScheduler.js";
import { closePool } from "./db/connection.js";

export const SHUTDOWN_TIMEOUT_MS = 10_000;

let server: Server | undefined;
let isShuttingDown = false;

export function setServer(s: Server | undefined): void {
  server = s;
}

export function resetShutdownFlag(): void {
  isShuttingDown = false;
}

export function startServer(
  listener: { listen: (port: number, callback?: () => void) => unknown },
  config: EnvConfig,
) {
  return listener.listen(config.port, () => {
    console.log(`ChronoPay API listening on http://localhost:${config.port}`);
  });
}

export async function gracefulShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  stopScheduler();

  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }

  await closePool();
}

async function shutdownWithTimeout(): Promise<void> {
  const timer = setTimeout(() => {
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await gracefulShutdown();
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
}

if (process.env.NODE_ENV !== "test") {
  const config = loadEnvConfig();
  const app = createApp();
  server = createServer(app);
  const port = config.port;

  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });

  process.on("SIGTERM", () => void shutdownWithTimeout());
  process.on("SIGINT", () => void shutdownWithTimeout());
}

export default server;
