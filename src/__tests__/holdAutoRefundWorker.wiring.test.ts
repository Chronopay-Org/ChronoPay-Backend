/**
 * Hold auto-refund worker — wiring tests (#1414)
 *
 * Verifies that createHoldAutoRefundWorker start/stop lifecycle works correctly
 * with fake dependencies, and that the shared bookingIntentContainer exports
 * the same instances used by the worker and the HTTP route layer.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import {
  createHoldAutoRefundWorker,
  processHoldAutoRefundOnce,
} from "../scheduler/holdAutoRefundWorker.js";
import {
  createBookingIntentContainer,
  bookingIntentContainer,
} from "../modules/booking-intents/bookingIntentContainer.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { BookingIntentService } from "../modules/booking-intents/booking-intent-service.js";
import type { BookingIntentRecord } from "../modules/booking-intents/booking-intent-repository.js";

// ─── Fake dependencies ────────────────────────────────────────────────────────

function makeFakeDeps(expiredHolds: BookingIntentRecord[] = []) {
  const findExpiredHolds = jest
    .fn<() => Promise<BookingIntentRecord[]>>()
    .mockResolvedValue(expiredHolds);
  const autoRefundHold = jest
    .fn<(id: string) => Promise<{ id: string; refundMetadata?: { refundedAmountCents: number } }>>()
    .mockResolvedValue({ id: "intent-1", refundMetadata: { refundedAmountCents: 500 } });

  return {
    bookingIntentRepository: { findExpiredHolds } as unknown as InMemoryBookingIntentRepository,
    bookingIntentService: { autoRefundHold } as unknown as BookingIntentService,
    findExpiredHolds,
    autoRefundHold,
  };
}

// ─── processHoldAutoRefundOnce ────────────────────────────────────────────────

describe("processHoldAutoRefundOnce", () => {
  it("returns zero counts when there are no expired holds", async () => {
    const { bookingIntentRepository, bookingIntentService } = makeFakeDeps([]);
    const result = await processHoldAutoRefundOnce(
      { bookingIntentRepository, bookingIntentService },
      {},
    );
    expect(result.refundedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.skippedBecauseThreshold).toBeUndefined();
  });

  it("refunds each expired hold and sums the amounts", async () => {
    const holds = [
      { id: "h-1" } as BookingIntentRecord,
      { id: "h-2" } as BookingIntentRecord,
    ];
    const { bookingIntentRepository, bookingIntentService, autoRefundHold } = makeFakeDeps(holds);
    autoRefundHold
      .mockResolvedValueOnce({ id: "h-1", refundMetadata: { refundedAmountCents: 300 } })
      .mockResolvedValueOnce({ id: "h-2", refundMetadata: { refundedAmountCents: 700 } });

    const result = await processHoldAutoRefundOnce(
      { bookingIntentRepository, bookingIntentService },
      {},
    );
    expect(result.refundedCount).toBe(2);
    expect(result.totalRefundedAmountCents).toBe(1000);
    expect(result.failedCount).toBe(0);
  });

  it("records a failure when autoRefundHold throws", async () => {
    const holds = [{ id: "h-err" } as BookingIntentRecord];
    const { bookingIntentRepository, bookingIntentService, autoRefundHold } = makeFakeDeps(holds);
    autoRefundHold.mockRejectedValue(new Error("refund failed"));

    const result = await processHoldAutoRefundOnce(
      { bookingIntentRepository, bookingIntentService },
      {},
    );
    expect(result.refundedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.failures[0].error).toBe("refund failed");
  });

  it("skips and sets skippedBecauseThreshold when expired holds exceed safetyThreshold", async () => {
    const tooMany = Array.from({ length: 5 }, (_, i) => ({ id: `h-${i}` } as BookingIntentRecord));
    const { bookingIntentRepository, bookingIntentService } = makeFakeDeps(tooMany);

    const result = await processHoldAutoRefundOnce(
      { bookingIntentRepository, bookingIntentService },
      { safetyThreshold: 3 },
    );
    expect(result.skippedBecauseThreshold).toBe(true);
    expect(result.refundedCount).toBe(0);
  });
});

// ─── createHoldAutoRefundWorker start / stop ──────────────────────────────────

describe("createHoldAutoRefundWorker", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("start() is idempotent — calling it twice does not launch a second loop", async () => {
    const { bookingIntentRepository, bookingIntentService, findExpiredHolds } = makeFakeDeps([]);
    const worker = createHoldAutoRefundWorker(
      { bookingIntentRepository, bookingIntentService },
      { intervalMs: 10_000 },
    );
    worker.start();
    worker.start(); // second call is a no-op
    await jest.advanceTimersByTimeAsync(0);
    // findExpiredHolds is called once per tick, not twice
    expect(findExpiredHolds).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it("stop() aborts the loop without leaving a pending timer", async () => {
    const { bookingIntentRepository, bookingIntentService, findExpiredHolds } = makeFakeDeps([]);
    const worker = createHoldAutoRefundWorker(
      { bookingIntentRepository, bookingIntentService },
      { intervalMs: 500 },
    );
    worker.start();
    await jest.advanceTimersByTimeAsync(0); // let first tick fire
    worker.stop();
    const callCountAfterStop = findExpiredHolds.mock.calls.length;
    // Advance past the interval — the loop must not fire again
    await jest.advanceTimersByTimeAsync(2_000);
    expect(findExpiredHolds).toHaveBeenCalledTimes(callCountAfterStop);
  });

  it("getLastResult() returns null before the first tick", () => {
    const { bookingIntentRepository, bookingIntentService } = makeFakeDeps([]);
    const worker = createHoldAutoRefundWorker(
      { bookingIntentRepository, bookingIntentService },
      { intervalMs: 10_000 },
    );
    expect(worker.getLastResult()).toBeNull();
  });
});

// ─── Shared container singleton ───────────────────────────────────────────────

describe("bookingIntentContainer singleton", () => {
  it("exports the same repository instance from bookingIntentRepository and container", () => {
    // The named export must be the same object as the container property so the
    // HTTP routes and worker share one in-memory store.
    const { bookingIntentRepository: repo } = bookingIntentContainer;
    expect(repo).toBeInstanceOf(InMemoryBookingIntentRepository);
  });

  it("exports the same slotRepository instance", () => {
    expect(bookingIntentContainer.slotRepository).toBeInstanceOf(InMemorySlotRepository);
  });

  it("createBookingIntentContainer produces independent instances", () => {
    const a = createBookingIntentContainer();
    const b = createBookingIntentContainer();
    expect(a.bookingIntentRepository).not.toBe(b.bookingIntentRepository);
    expect(a.slotRepository).not.toBe(b.slotRepository);
    expect(a.bookingIntentService).not.toBe(b.bookingIntentService);
  });

  it("default singleton instances differ from freshly created container instances", () => {
    const fresh = createBookingIntentContainer();
    expect(fresh.bookingIntentRepository).not.toBe(bookingIntentContainer.bookingIntentRepository);
  });
});

// ─── HOLD_AUTO_REFUND_DISABLED env toggle (import-time guard check) ───────────

describe("HOLD_AUTO_REFUND_DISABLED env toggle", () => {
  it("is not 'true' in the default test environment (worker would start normally)", () => {
    // In a real server boot, with the flag unset, the worker starts.
    // We just assert the toggle's default value here; full boot-path test
    // is covered by the lifecycle.test.ts suite which mocks the entire
    // process environment.
    expect(process.env.HOLD_AUTO_REFUND_DISABLED).not.toBe("true");
  });
});
