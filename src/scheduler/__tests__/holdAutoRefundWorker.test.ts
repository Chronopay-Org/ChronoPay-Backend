import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { BookingIntentRecord } from "../../modules/booking-intents/booking-intent-repository.js";
import { logger } from "../../utils/logger.js";
import { createHoldAutoRefundWorker, runHoldAutoRefundWorker } from "../holdAutoRefundWorker.js";

type Dependencies = Parameters<typeof runHoldAutoRefundWorker>[1];
const INTERVAL_MS = 1_000;

function createDependencies() {
  const findExpiredHolds = jest.fn<Dependencies["bookingIntentRepository"]["findExpiredHolds"]>();
  const autoRefundHold = jest.fn<Dependencies["bookingIntentService"]["autoRefundHold"]>();
  const dependencies: Dependencies = {
    bookingIntentRepository: {
      findExpiredHolds,
    } as unknown as Dependencies["bookingIntentRepository"],
    bookingIntentService: { autoRefundHold } as unknown as Dependencies["bookingIntentService"],
  };
  return { dependencies, findExpiredHolds, autoRefundHold };
}

describe("hold auto-refund worker error recovery", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(logger, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("logs a failed query, waits the full interval, and refunds on the next cycle", async () => {
    const { dependencies, findExpiredHolds, autoRefundHold } = createDependencies();
    const error = new Error("temporary database failure");
    const hold: BookingIntentRecord = {
      id: "expired-hold",
      slotId: "slot-1",
      professional: "supplier-1",
      customerId: "buyer-1",
      startTime: 1,
      endTime: 2,
      status: "hold_placed",
      createdAt: new Date(0).toISOString(),
    };
    findExpiredHolds.mockRejectedValueOnce(error).mockResolvedValue([hold]);
    autoRefundHold.mockResolvedValue({ ...hold, status: "hold_refunded" });
    const controller = new AbortController();
    const completion = runHoldAutoRefundWorker(controller.signal, dependencies, {
      intervalMs: INTERVAL_MS,
    });
    // Observe rejection immediately so the regression also fails safely on the
    // old implementation instead of leaking a rejected test promise.
    const outcome = completion.then(
      () => undefined,
      (err: unknown) => err,
    );

    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledWith({ err: error }, "[hold-auto-refund] cycle failed");
      expect(findExpiredHolds).toHaveBeenCalledTimes(1);
      expect(autoRefundHold).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(INTERVAL_MS - 1);
      expect(findExpiredHolds).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(findExpiredHolds).toHaveBeenCalledTimes(2);
      expect(autoRefundHold).toHaveBeenCalledWith(hold.id);
    } finally {
      controller.abort();
      await outcome;
    }
    await expect(completion).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("keeps the factory worker running after a query failure without an unhandled rejection", async () => {
    const { dependencies, findExpiredHolds } = createDependencies();
    const error = new Error("temporary database failure");
    findExpiredHolds.mockRejectedValueOnce(error).mockResolvedValue([]);
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    const worker = createHoldAutoRefundWorker(dependencies, { intervalMs: INTERVAL_MS });

    try {
      worker.start();
      worker.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledWith({ err: error }, "[hold-auto-refund] cycle failed");
      expect(findExpiredHolds).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(INTERVAL_MS - 1);
      expect(findExpiredHolds).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(findExpiredHolds).toHaveBeenCalledTimes(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      worker.stop();
      await jest.advanceTimersByTimeAsync(0);
      process.off("unhandledRejection", unhandled);
    }
    expect(jest.getTimerCount()).toBe(0);
  });

  it("catches an unexpected loop rejection and releases the factory running flag", async () => {
    const { dependencies, findExpiredHolds } = createDependencies();
    findExpiredHolds.mockResolvedValue([]);
    const error = new Error("unexpected configuration failure");
    let failOnce = true;
    const worker = createHoldAutoRefundWorker(dependencies, {
      get intervalMs() {
        if (failOnce) {
          failOnce = false;
          throw error;
        }
        return INTERVAL_MS;
      },
    });
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);

    try {
      worker.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledWith({ err: error }, "[hold-auto-refund] worker failed");
      expect(findExpiredHolds).not.toHaveBeenCalled();

      worker.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(findExpiredHolds).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      worker.stop();
      await jest.advanceTimersByTimeAsync(0);
      process.off("unhandledRejection", unhandled);
    }
    expect(jest.getTimerCount()).toBe(0);
  });
});
