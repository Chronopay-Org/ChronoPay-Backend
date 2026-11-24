import { jest } from "@jest/globals";
import {
  startAccessReviewWorker,
  stopAccessReviewWorker,
  isAccessReviewWorkerRunning,
} from "../accessReviewWorker.js";
import { accessReviewService } from "../../services/accessReviewService.js";
import { logger } from "../../utils/logger.js";

describe("accessReviewWorker", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(accessReviewService, "listSnapshots").mockReturnValue({
      snapshots: [],
      total: 0,
    } as any);
    jest.spyOn(accessReviewService, "detectGaps").mockReturnValue({
      missingQuarters: [],
    } as any);
  });

  afterEach(() => {
    stopAccessReviewWorker();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("logs a failing snapshot without throwing an unhandled rejection", async () => {
    const boom = new Error("snapshot store unavailable");
    const createSnapshotSpy = jest
      .spyOn(accessReviewService, "createSnapshot")
      .mockImplementation(async () => {
        throw boom;
      });
    const errorSpy = jest.spyOn(logger, "error").mockImplementation((() => {}) as any);

    startAccessReviewWorker(60_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(createSnapshotSpy).toHaveBeenCalledTimes(1);
    expect(createSnapshotSpy).toHaveBeenCalledWith(false);
    expect(errorSpy).toHaveBeenCalledWith({ err: boom }, "[access-review] check failed");
  });

  it("keeps firing on the interval after a failure", async () => {
    const boom = new Error("transient failure");
    const createSnapshotSpy = jest
      .spyOn(accessReviewService, "createSnapshot")
      .mockImplementationOnce(async () => {
        throw boom;
      })
      .mockImplementationOnce(async () => ({
        snapshotId: "snap-2",
        quarterLabel: "2026-Q4",
      }) as any);
    const errorSpy = jest.spyOn(logger, "error").mockImplementation((() => {}) as any);

    startAccessReviewWorker(60_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(createSnapshotSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({ err: boom }, "[access-review] check failed");

    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(createSnapshotSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("never overlaps two slow runs", async () => {
    let resolveFirst!: (value: any) => void;
    const firstRun = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const createSnapshotSpy = jest
      .spyOn(accessReviewService, "createSnapshot")
      .mockReturnValueOnce(firstRun as any)
      .mockResolvedValueOnce({
        snapshotId: "snap-2",
        quarterLabel: "2026-Q4",
      } as any);

    startAccessReviewWorker(60_000);
    await Promise.resolve();

    expect(createSnapshotSpy).toHaveBeenCalledTimes(1);

    // Advance across multiple intervals while the first run is still in flight
    jest.advanceTimersByTime(60_000 * 3);
    await Promise.resolve();

    expect(createSnapshotSpy).toHaveBeenCalledTimes(1);

    // Complete the first run; the next interval tick should run normally
    resolveFirst({ snapshotId: "snap-1", quarterLabel: "2026-Q4" });
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(createSnapshotSpy).toHaveBeenCalledTimes(2);
  });

  it("reports running state accurately across start and stop", () => {
    expect(isAccessReviewWorkerRunning()).toBe(false);
    startAccessReviewWorker(60_000);
    expect(isAccessReviewWorkerRunning()).toBe(true);
    stopAccessReviewWorker();
    expect(isAccessReviewWorkerRunning()).toBe(false);
  });
});
