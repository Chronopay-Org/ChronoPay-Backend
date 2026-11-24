/**
 * Bootstrap helper for the timezone drift monitor (#1427).
 *
 * Starts `runTzDriftMonitor` against the live slot repository unless
 * TZ_DRIFT_MONITOR_DISABLED=true, and registers a stop hook that aborts the
 * loop and waits for it to finish.
 */

import { logger } from "../utils/logger.js";
import { runTzDriftMonitor } from "./tzDriftMonitor.js";
import { SlotRepositoryTzStore, type SlotListSource } from "./slotRepositoryTzStore.js";

export function startTzDriftMonitor(
  lifecycle: { registerStop(name: string, close: () => Promise<void> | void): void },
  slotSource: SlotListSource,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.TZ_DRIFT_MONITOR_DISABLED === "true") {
    logger.info("tz-drift-monitor disabled via TZ_DRIFT_MONITOR_DISABLED");
    return false;
  }

  const controller = new AbortController();
  const worker = runTzDriftMonitor(
    controller.signal,
    new SlotRepositoryTzStore(slotSource),
  ).catch((err: Error) => {
    logger.error({ err }, "tz-drift-monitor exited unexpectedly");
  });
  lifecycle.registerStop("tz-drift-monitor", async () => {
    controller.abort();
    await worker;
  });
  logger.info("tz-drift-monitor started");
  return true;
}
