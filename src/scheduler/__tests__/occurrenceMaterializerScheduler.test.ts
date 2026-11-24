import { afterEach, expect, it, jest } from "@jest/globals";
import {
  createOccurrenceMaterializerScheduler,
  DEFAULT_OCCURRENCE_MATERIALIZER_INTERVAL_MS,
} from "../occurrenceMaterializerScheduler.js";
import type { MaterializationReport } from "../occurrenceMaterializer.js";

const report: MaterializationReport = {
  seriesProcessed: 2,
  seriesFailed: 0,
  occurrencesMaterialized: 20,
  staleCleaned: 1,
  expiredCleaned: 3,
  errors: [],
};

afterEach(() => {
  jest.useRealTimers();
});

it("uses the hourly default and coalesces overlapping triggers into one run", async () => {
  jest.useFakeTimers();
  let finishMaterialization!: (result: MaterializationReport) => void;
  const materialize = jest.fn(
    () =>
      new Promise<MaterializationReport>((resolve) => {
        finishMaterialization = resolve;
      }),
  );
  const scheduler = createOccurrenceMaterializerScheduler({ materialize });

  expect(DEFAULT_OCCURRENCE_MATERIALIZER_INTERVAL_MS).toBe(60 * 60 * 1_000);
  scheduler.start();
  expect(jest.getTimerCount()).toBe(1);

  await jest.advanceTimersByTimeAsync(DEFAULT_OCCURRENCE_MATERIALIZER_INTERVAL_MS);
  expect(materialize).toHaveBeenCalledTimes(1);

  const first = scheduler.runOnce();
  const overlapping = scheduler.runOnce();
  expect(overlapping).toBe(first);

  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  expect(stopped).toBe(false);
  finishMaterialization(report);
  await Promise.all([first, stopping]);
  expect(stopped).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

it("does not start a run after shutdown has begun", async () => {
  const materialize = jest.fn(async () => report);
  const scheduler = createOccurrenceMaterializerScheduler({
    materialize,
    isShuttingDown: () => true,
  });

  await scheduler.runOnce();

  expect(materialize).not.toHaveBeenCalled();
});
