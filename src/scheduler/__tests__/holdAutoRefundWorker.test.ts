import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  processHoldAutoRefundOnce,
  HoldAutoRefundWorkerConfig,
} from "../holdAutoRefundWorker.js";
import type {
  BookingIntentRecord,
  BookingIntentRepository,
} from "../../modules/booking-intents/booking-intent-repository.js";
import type { BookingIntentService } from "../../modules/booking-intents/booking-intent-service.js";

// ─── Fakes ────────────────────────────────────────────────────────────────────

function makeHold(id: string): BookingIntentRecord {
  return {
    id,
    slotId: `slot-${id}`,
    professional: "prof-1",
    customerId: "cust-1",
    startTime: 1_000,
    endTime: 2_000,
    status: "hold_placed",
    createdAt: "2026-01-01T00:00:00.000Z",
    bookingType: "refundable_hold",
    holdUntilMs: 1_500,
  } as BookingIntentRecord;
}

function makeRepository(holds: BookingIntentRecord[]) {
  return {
    findExpiredHolds: jest.fn(async (_nowMs: number) => holds),
  };
}

/**
 * Fake service. `refundAmounts` maps an intent id to the amount reported for a
 * successful refund; any id in `failing` throws instead.
 */
function makeService(options: {
  refundAmounts?: Record<string, number>;
  failing?: Record<string, Error | string>;
} = {}) {
  const refundAmounts = options.refundAmounts ?? {};
  const failing = options.failing ?? {};

  return {
    autoRefundHold: jest.fn(async (intentId: string) => {
      const failure = failing[intentId];
      if (failure !== undefined) {
        throw failure;
      }
      return {
        id: intentId,
        refundMetadata: {
          refundedAt: "2026-01-01T00:00:00.000Z",
          refundedAmountCents: refundAmounts[intentId] ?? 0,
          refundReason: "hold_auto_refund",
        },
      } as unknown as BookingIntentRecord;
    }),
  };
}

type FakeRepository = ReturnType<typeof makeRepository>;
type FakeService = ReturnType<typeof makeService>;

function dependencies(repository: FakeRepository, service: FakeService) {
  return {
    bookingIntentRepository: repository as unknown as BookingIntentRepository,
    bookingIntentService: service as unknown as BookingIntentService,
  };
}

const ENV_KEYS = [
  "HOLD_AUTO_REFUND_BATCH_SIZE",
  "HOLD_AUTO_REFUND_SAFETY_THRESHOLD",
  "HOLD_AUTO_REFUND_INTERVAL_MS",
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};

describe("processHoldAutoRefundOnce", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      ORIGINAL_ENV[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = ORIGINAL_ENV[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
      delete ORIGINAL_ENV[key];
    }
  });

  // ── Safety threshold ──────────────────────────────────────────────────────

  it("skips everything when expired holds exceed the safety threshold", async () => {
    const holds = Array.from({ length: 11 }, (_, i) => makeHold(`h${i}`));
    const repository = makeRepository(holds);
    const service = makeService();

    const result = await processHoldAutoRefundOnce(dependencies(repository, service), {
      safetyThreshold: 10,
    });

    expect(result).toEqual({
      refundedCount: 0,
      totalRefundedAmountCents: 0,
      failedCount: 0,
      failures: [],
      skippedBecauseThreshold: true,
    });
    expect(service.autoRefundHold).not.toHaveBeenCalled();
  });

  it("does not skip when expired holds are exactly at the safety threshold", async () => {
    const holds = Array.from({ length: 10 }, (_, i) => makeHold(`h${i}`));
    const repository = makeRepository(holds);
    const service = makeService();

    const result = await processHoldAutoRefundOnce(dependencies(repository, service), {
      safetyThreshold: 10,
    });

    expect(result.skippedBecauseThreshold).toBeUndefined();
    expect(result.refundedCount).toBe(10);
    expect(service.autoRefundHold).toHaveBeenCalledTimes(10);
  });

  it("passes the effective clock to findExpiredHolds", async () => {
    const repository = makeRepository([]);
    const service = makeService();

    await processHoldAutoRefundOnce(dependencies(repository, service), {}, 1_234_567);

    expect(repository.findExpiredHolds).toHaveBeenCalledWith(1_234_567);
  });

  // ── Batching ──────────────────────────────────────────────────────────────

  it("caps the number of refunds at batchSize and leaves the rest untouched", async () => {
    const holds = Array.from({ length: 10 }, (_, i) => makeHold(`h${i}`));
    const repository = makeRepository(holds);
    const service = makeService();

    const result = await processHoldAutoRefundOnce(dependencies(repository, service), {
      batchSize: 3,
    });

    expect(service.autoRefundHold).toHaveBeenCalledTimes(3);
    const refundedIds = service.autoRefundHold.mock.calls.map((call) => call[0]);
    expect(refundedIds).toEqual(["h0", "h1", "h2"]);
    expect(result.refundedCount).toBe(3);
    expect(result.failedCount).toBe(0);
  });

  it("refunds every hold when fewer than batchSize exist", async () => {
    const holds = [makeHold("h0"), makeHold("h1")];
    const repository = makeRepository(holds);
    const service = makeService();

    const result = await processHoldAutoRefundOnce(dependencies(repository, service), {
      batchSize: 100,
    });

    expect(service.autoRefundHold).toHaveBeenCalledTimes(2);
    expect(result.refundedCount).toBe(2);
  });

  it("returns an empty result when no holds have expired", async () => {
    const repository = makeRepository([]);
    const service = makeService();

    const result = await processHoldAutoRefundOnce(dependencies(repository, service));

    expect(service.autoRefundHold).not.toHaveBeenCalled();
    expect(result).toEqual({
      refundedCount: 0,
      totalRefundedAmountCents: 0,
      failedCount: 0,
      failures: [],
    });
  });

  // ── Amount aggregation ────────────────────────────────────────────────────

  it("sums refundedAmountCents across successful refunds", async () => {
    const holds = [makeHold("h0"), makeHold("h1"), makeHold("h2")];
    const repository = makeRepository(holds);
    const service = makeService({
      refundAmounts: { h0: 500, h1: 1_250, h2: 0 },
    });

    const result = await processHoldAutoRefundOnce(dependencies(repository, service));

    expect(result.refundedCount).toBe(3);
    expect(result.totalRefundedAmountCents).toBe(1_750);
    expect(result.failedCount).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it("treats a missing refundMetadata refundedAmountCents as zero", async () => {
    const holds = [makeHold("h0")];
    const repository = makeRepository(holds);
    const service = {
      autoRefundHold: jest.fn(
        async (intentId: string) => ({ id: intentId }) as unknown as BookingIntentRecord,
      ),
    };

    const result = await processHoldAutoRefundOnce(
      dependencies(repository, service as unknown as FakeService),
    );

    expect(result.refundedCount).toBe(1);
    expect(result.totalRefundedAmountCents).toBe(0);
  });

  // ── Failure collection ────────────────────────────────────────────────────

  it("collects a thrown Error into failures while other refunds succeed", async () => {
    const holds = [makeHold("h0"), makeHold("h1"), makeHold("h2")];
    const repository = makeRepository(holds);
    const service = makeService({
      refundAmounts: { h0: 100, h2: 200 },
      failing: { h1: new Error("hold already refunded") },
    });

    const result = await processHoldAutoRefundOnce(dependencies(repository, service));

    expect(result.refundedCount).toBe(2);
    expect(result.totalRefundedAmountCents).toBe(300);
    expect(result.failedCount).toBe(1);
    expect(result.failures).toEqual([
      {
        intentId: "h1",
        success: false,
        refundedAmountCents: 0,
        error: "hold already refunded",
      },
    ]);
  });

  it("stringifies non-Error throws into the failure message", async () => {
    const holds = [makeHold("h0")];
    const repository = makeRepository(holds);
    const service = makeService({ failing: { h0: "boom" } });

    const result = await processHoldAutoRefundOnce(dependencies(repository, service));

    expect(result.failedCount).toBe(1);
    expect(result.failures[0]).toEqual({
      intentId: "h0",
      success: false,
      refundedAmountCents: 0,
      error: "boom",
    });
  });

  it("keeps collecting failures for every failing hold instead of aborting the batch", async () => {
    const holds = [makeHold("h0"), makeHold("h1"), makeHold("h2"), makeHold("h3")];
    const repository = makeRepository(holds);
    const service = makeService({
      failing: { h1: new Error("first"), h3: new Error("second") },
    });

    const result = await processHoldAutoRefundOnce(
      dependencies(repository, service),
      { batchSize: 4 },
    );

    expect(service.autoRefundHold).toHaveBeenCalledTimes(4);
    expect(result.refundedCount).toBe(2);
    expect(result.failedCount).toBe(2);
    expect(result.failures.map((f) => f.intentId)).toEqual(["h1", "h3"]);
    expect(result.failures.map((f) => f.error)).toEqual(["first", "second"]);
  });

  // ── Config resolution (env parsing) ───────────────────────────────────────

  describe("config resolution", () => {
    const cases: Array<{
      label: string;
      value: string;
      expectedCalls: number;
    }> = [
      { label: "non-numeric", value: "abc", expectedCalls: 12 },
      { label: "zero", value: "0", expectedCalls: 12 },
      { label: "negative", value: "-5", expectedCalls: 12 },
      { label: "fractional", value: "2.5", expectedCalls: 12 },
      { label: "empty", value: "", expectedCalls: 12 },
    ];

    for (const { label, value, expectedCalls } of cases) {
      it(`falls back to the default batch size for a ${label} env value`, async () => {
        process.env.HOLD_AUTO_REFUND_BATCH_SIZE = value;
        const holds = Array.from({ length: 12 }, (_, i) => makeHold(`h${i}`));
        const repository = makeRepository(holds);
        const service = makeService();

        const result = await processHoldAutoRefundOnce(dependencies(repository, service));

        expect(service.autoRefundHold).toHaveBeenCalledTimes(expectedCalls);
        expect(result.refundedCount).toBe(expectedCalls);
      });
    }

    it("honours a valid HOLD_AUTO_REFUND_BATCH_SIZE from the environment", async () => {
      process.env.HOLD_AUTO_REFUND_BATCH_SIZE = "2";
      const holds = Array.from({ length: 5 }, (_, i) => makeHold(`h${i}`));
      const repository = makeRepository(holds);
      const service = makeService();

      const result = await processHoldAutoRefundOnce(dependencies(repository, service));

      expect(service.autoRefundHold).toHaveBeenCalledTimes(2);
      expect(result.refundedCount).toBe(2);
    });

    it("falls back to the default safety threshold for an invalid env value", async () => {
      // Default threshold is 1000: 20 holds must not trip the brake.
      process.env.HOLD_AUTO_REFUND_SAFETY_THRESHOLD = "0";
      const holds = Array.from({ length: 20 }, (_, i) => makeHold(`h${i}`));
      const repository = makeRepository(holds);
      const service = makeService();

      const result = await processHoldAutoRefundOnce(dependencies(repository, service));

      expect(result.skippedBecauseThreshold).toBeUndefined();
      expect(result.refundedCount).toBe(20);
    });

    it("honours a valid HOLD_AUTO_REFUND_SAFETY_THRESHOLD from the environment", async () => {
      process.env.HOLD_AUTO_REFUND_SAFETY_THRESHOLD = "5";
      const holds = Array.from({ length: 6 }, (_, i) => makeHold(`h${i}`));
      const repository = makeRepository(holds);
      const service = makeService();

      const result = await processHoldAutoRefundOnce(dependencies(repository, service));

      expect(result.skippedBecauseThreshold).toBe(true);
      expect(service.autoRefundHold).not.toHaveBeenCalled();
    });

    it("prefers explicit overrides over environment values", async () => {
      process.env.HOLD_AUTO_REFUND_BATCH_SIZE = "1";
      process.env.HOLD_AUTO_REFUND_SAFETY_THRESHOLD = "1";
      const holds = Array.from({ length: 5 }, (_, i) => makeHold(`h${i}`));
      const repository = makeRepository(holds);
      const service = makeService();
      const overrides: HoldAutoRefundWorkerConfig = {
        batchSize: 4,
        safetyThreshold: 10,
      };

      const result = await processHoldAutoRefundOnce(
        dependencies(repository, service),
        overrides,
      );

      expect(result.skippedBecauseThreshold).toBeUndefined();
      expect(service.autoRefundHold).toHaveBeenCalledTimes(4);
    });
  });
});
