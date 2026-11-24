import {
  materializeAllSeries,
  type MaterializationReport,
} from "./occurrenceMaterializer.js";
import { logger } from "../utils/logger.js";

export const DEFAULT_OCCURRENCE_MATERIALIZER_INTERVAL_MS = 60 * 60 * 1_000;

export interface OccurrenceMaterializerSchedulerOptions {
  intervalMs?: number;
  materialize?: () => Promise<MaterializationReport>;
  isShuttingDown?: () => boolean;
}

export interface OccurrenceMaterializerScheduler {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<void>;
}

export function createOccurrenceMaterializerScheduler(
  options: OccurrenceMaterializerSchedulerOptions = {},
): OccurrenceMaterializerScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_OCCURRENCE_MATERIALIZER_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError("Occurrence materializer interval must be a positive safe integer");
  }

  const materialize = options.materialize ?? materializeAllSeries;
  const isShuttingDown = options.isShuttingDown ?? (() => false);
  let interval: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const runOnce = (): Promise<void> => {
    if (stopped || isShuttingDown()) return Promise.resolve();
    if (inFlight) return inFlight;

    const run = Promise.resolve()
      .then(() => materialize())
      .then((report) => {
        logger.info(
          {
            seriesProcessed: report.seriesProcessed,
            seriesFailed: report.seriesFailed,
            occurrencesMaterialized: report.occurrencesMaterialized,
            staleCleaned: report.staleCleaned,
            expiredCleaned: report.expiredCleaned,
          },
          "Occurrence materialization completed",
        );
      })
      .catch((err: unknown) => {
        logger.error({ err }, "Occurrence materialization failed");
      })
      .finally(() => {
        inFlight = null;
      });

    inFlight = run;
    return run;
  };

  return {
    start(): void {
      if (stopped || interval) return;
      interval = setInterval(() => {
        void runOnce();
      }, intervalMs);
      if (typeof interval === "object" && "unref" in interval) interval.unref();
      logger.info({ intervalMs }, "Occurrence materializer scheduler started");
    },
    async stop(): Promise<void> {
      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      await inFlight;
    },
    runOnce,
  };
}
