// @ts-nocheck
import { jest } from "@jest/globals";
import {
  expireBookingIntentsOnce,
  runExpireBookingIntentsWorker,
  createExpireBookingIntentsWorker,
  bookingIntentExpiredEvents,
  BookingIntentExpiredEvent,
} from "../expireBookingIntents.js";
import { BookingIntentService } from "../../modules/booking-intents/booking-intent-service.js";
import {
  InMemoryBookingIntentRepository,
  BookingIntentRepository,
} from "../../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../../modules/slots/slot-repository.js";
import { register } from "../../metrics.js";

const SLOT_1 = "slot-11111111-1111-4111-8111-111111111111";
const SLOT_2 = "slot-22222222-2222-4222-8222-222222222222";
const SLOT_3 = "slot-33333333-3333-4333-8333-333333333333";

const TTL_30_MIN = 30 * 60 * 1000;

async function metricValue(metric: string): Promise<number> {
  const metrics = await register.metrics();
  const line = metrics.split("\n").find((entry) => entry.startsWith(metric));
  if (!line) return 0;
  return Number(line.trim().split(/\s+/).at(-1));
}

describe("expireBookingIntents worker", () => {
  const baseTime = 1_700_000_000_000;
  let bookingIntentRepo: InMemoryBookingIntentRepository;
  let slotRepo: InMemorySlotRepository;
  let bookingIntentService: BookingIntentService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(baseTime);
    bookingIntentRepo = new InMemoryBookingIntentRepository();
    slotRepo = new InMemorySlotRepository();
    bookingIntentService = new BookingIntentService(
      bookingIntentRepo,
      slotRepo,
      () => new Date(baseTime).toISOString(),
    );
    register.resetMetrics();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function createPendingIntent(slotId: string, customerId = "customer-1") {
    return bookingIntentService.createIntent(
      { slotId },
      { userId: customerId, role: "customer" },
    );
  }

  it("expires stale pending booking intents older than the TTL and releases the slot", async () => {
    const intent = await createPendingIntent(SLOT_1);

    const emitted: BookingIntentExpiredEvent[] = [];
    const listener = (event: BookingIntentExpiredEvent) => emitted.push(event);
    bookingIntentExpiredEvents.on("booking_intent_expired", listener);

    try {
      const result = await expireBookingIntentsOnce(
        { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
        { ttlMs: TTL_30_MIN, batchSize: 10 },
        baseTime + TTL_30_MIN, // createdAt (baseTime) is exactly at the cutoff
      );

      expect(result.expiredCount).toBe(1);
      expect(result.candidatesCount).toBe(1);
      expect(result.failures).toEqual([]);

      const updated = bookingIntentRepo.findById(intent.id);
      expect(updated?.status).toBe("expired");

      // Slot inventory released back to bookable.
      expect(slotRepo.findById(SLOT_1)?.bookable).toBe(true);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].intentId).toBe(intent.id);
      expect(emitted[0].slotId).toBe(SLOT_1);
      expect(emitted[0].customerId).toBe("customer-1");
      expect(emitted[0].expiredAtMs).toBe(baseTime + TTL_30_MIN);

      expect(await metricValue("booking_intents_expired_total")).toBe(1);
    } finally {
      bookingIntentExpiredEvents.off("booking_intent_expired", listener);
    }
  });

  it("does not expire intents still within the TTL", async () => {
    const intent = await createPendingIntent(SLOT_1);

    const result = await expireBookingIntentsOnce(
      { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
      { ttlMs: TTL_30_MIN },
      baseTime + TTL_30_MIN - 1, // 1 ms before the 30-minute cutoff
    );

    expect(result.expiredCount).toBe(0);
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("pending");
    // Slot must remain reserved.
    expect(slotRepo.findById(SLOT_1)?.bookable).toBe(false);
    expect(await metricValue("booking_intents_expired_total")).toBe(0);
  });

  it("expires an intent whose createdAt is exactly at the 30-minute boundary", async () => {
    const intent = await createPendingIntent(SLOT_1);

    const result = await expireBookingIntentsOnce(
      { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
      { ttlMs: TTL_30_MIN },
      baseTime + TTL_30_MIN, // createdAt === cutoff → stale
    );

    expect(result.expiredCount).toBe(1);
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
  });

  it("never double-cancels when two workers sweep the same intents", async () => {
    const intent = await createPendingIntent(SLOT_1);
    const deps = { bookingIntentRepository: bookingIntentRepo, bookingIntentService };

    const first = await expireBookingIntentsOnce(deps, { ttlMs: TTL_30_MIN }, baseTime + TTL_30_MIN);
    const second = await expireBookingIntentsOnce(deps, { ttlMs: TTL_30_MIN }, baseTime + TTL_30_MIN);

    expect(first.expiredCount).toBe(1);
    // Second sweep finds nothing to do: status is already expired and the
    // candidate query only returns `pending` intents.
    expect(second.expiredCount).toBe(0);
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
    expect(slotRepo.findById(SLOT_1)?.bookable).toBe(true);
    expect(await metricValue("booking_intents_expired_total")).toBe(1);
  });

  it("skips intents that are no longer pending (e.g. slot already completed)", async () => {
    const intent = await createPendingIntent(SLOT_1);
    // Simulate a concurrent transition (e.g. buyer confirmed before the worker).
    const confirmed = bookingIntentRepo.updateStatus(intent.id, "confirmed");

    // Force the stale-candidate query to return the now-confirmed intent, as
    // could happen between the candidate fetch and the re-verification.
    const raceyRepo: BookingIntentRepository = {
      ...bookingIntentRepo,
      findStalePendingIntents: () => [confirmed],
    };

    const result = await expireBookingIntentsOnce(
      { bookingIntentRepository: raceyRepo, bookingIntentService },
      { ttlMs: TTL_30_MIN },
      baseTime + TTL_30_MIN,
    );

    expect(result.expiredCount).toBe(0);
    // Intent untouched, slot not released.
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("confirmed");
    expect(slotRepo.findById(SLOT_1)?.bookable).toBe(false);
    expect(await metricValue("booking_intents_expired_total")).toBe(0);
  });

  it("expires multiple stale intents and leaves fresh ones alone", async () => {
    const stale1 = await createPendingIntent(SLOT_1);
    const stale2 = await createPendingIntent(SLOT_2);

    // SLOT_3 is seeded non-bookable; make it bookable so a fresh intent can exist.
    slotRepo.updateBookable(SLOT_3, true);
    const fresh = await createPendingIntent(SLOT_3, "customer-3");
    // Push the fresh intent's creation time inside the TTL window.
    bookingIntentRepo.update(fresh.id, {
      createdAt: new Date(baseTime + TTL_30_MIN + 1000).toISOString(),
    });

    const result = await expireBookingIntentsOnce(
      { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
      { ttlMs: TTL_30_MIN },
      baseTime + TTL_30_MIN,
    );

    expect(result.expiredCount).toBe(2);
    expect(bookingIntentRepo.findById(stale1.id)?.status).toBe("expired");
    expect(bookingIntentRepo.findById(stale2.id)?.status).toBe("expired");
    expect(bookingIntentRepo.findById(fresh.id)?.status).toBe("pending");
  });

  it("respects the batch size when more intents are stale than the batch limit", async () => {
    const stale1 = await createPendingIntent(SLOT_1);
    const stale2 = await createPendingIntent(SLOT_2);
    slotRepo.updateBookable(SLOT_3, true);
    const stale3 = await createPendingIntent(SLOT_3, "customer-3");

    const result = await expireBookingIntentsOnce(
      { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
      { ttlMs: TTL_30_MIN, batchSize: 2 },
      baseTime + TTL_30_MIN,
    );

    expect(result.expiredCount).toBe(2);
    expect(result.candidatesCount).toBe(2);
    // Oldest two intents are processed in this sweep; the third waits for the
    // next sweep. Only one slot release for SLOT_1 remains for the next run.
    expect(bookingIntentRepo.findById(stale1.id)?.status).toBe("expired");
    expect(bookingIntentRepo.findById(stale2.id)?.status).toBe("expired");
    expect(bookingIntentRepo.findById(stale3.id)?.status).toBe("pending");
  });

  it("trips the safety brake when candidates exceed the threshold", async () => {
    await createPendingIntent(SLOT_1);
    await createPendingIntent(SLOT_2);

    const result = await expireBookingIntentsOnce(
      { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
      { ttlMs: TTL_30_MIN, safetyThreshold: 1 },
      baseTime + TTL_30_MIN,
    );

    expect(result.skippedBecauseThreshold).toBe(true);
    expect(result.expiredCount).toBe(0);
    expect(result.candidatesCount).toBe(2);
    expect(await metricValue("expire_booking_intents_safety_brake_triggers_total")).toBe(1);
  });

  it("records per-intent failures without aborting the sweep", async () => {
    await createPendingIntent(SLOT_1);

    const emitExpired = jest.fn(async () => {
      throw new Error("outbox write failed");
    });

    const result = await expireBookingIntentsOnce(
      {
        bookingIntentRepository: bookingIntentRepo,
        bookingIntentService,
        emitExpired,
      },
      { ttlMs: TTL_30_MIN },
      baseTime + TTL_30_MIN,
    );

    // The domain transition succeeds; only the event delivery fails.
    expect(result.expiredCount).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toMatch(/event emission failed: outbox write failed/);
    expect(bookingIntentRepo.listAll()[0].status).toBe("expired");
  });

  it("records a string (non-Error) event emission failure", async () => {
    await createPendingIntent(SLOT_1);

    const emitExpired = jest.fn(async () => {
      throw "outbox is down";
    });

    const result = await expireBookingIntentsOnce(
      {
        bookingIntentRepository: bookingIntentRepo,
        bookingIntentService,
        emitExpired,
      },
      { ttlMs: TTL_30_MIN },
      baseTime + TTL_30_MIN,
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toMatch(/event emission failed: outbox is down/);
  });

  it("skips candidates whose intent can no longer be found", async () => {
    class MissingFindRepo extends InMemoryBookingIntentRepository {
      findById() {
        return undefined;
      }
    }

    const repo = new MissingFindRepo();
    const service = new BookingIntentService(
      repo,
      slotRepo,
      () => new Date(baseTime).toISOString(),
    );
    const intent = await service.createIntent(
      { slotId: SLOT_1 },
      { userId: "customer-1", role: "customer" },
    );

    const result = await expireBookingIntentsOnce(
      { bookingIntentRepository: repo, bookingIntentService: service },
      { ttlMs: TTL_30_MIN },
      baseTime + TTL_30_MIN,
    );

    expect(result.expiredCount).toBe(0);
    expect(repo.listAll()[0].status).toBe("pending");
    expect(intent.id).toBeDefined();
  });

  it("survives non-Error failures thrown by the repository", async () => {
    class ThrowingFindRepo extends InMemoryBookingIntentRepository {
      findById() {
        throw "repository exploded";
      }
    }

    const repo = new ThrowingFindRepo();
    const service = new BookingIntentService(
      repo,
      slotRepo,
      () => new Date(baseTime).toISOString(),
    );
    const intent = await service.createIntent(
      { slotId: SLOT_1 },
      { userId: "customer-1", role: "customer" },
    );

    const result = await expireBookingIntentsOnce(
      { bookingIntentRepository: repo, bookingIntentService: service },
      { ttlMs: TTL_30_MIN },
      baseTime + TTL_30_MIN,
    );

    expect(result.expiredCount).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].intentId).toBe(intent.id);
    expect(result.failures[0].error).toBe("repository exploded");
  });

  it("honors the emitExpired dependency for durable outbox wiring", async () => {
    const intent = await createPendingIntent(SLOT_1);
    const emitExpired = jest.fn(async (event: BookingIntentExpiredEvent) => {
      expect(event.intentId).toBe(intent.id);
    });

    await expireBookingIntentsOnce(
      {
        bookingIntentRepository: bookingIntentRepo,
        bookingIntentService,
        emitExpired,
      },
      { ttlMs: TTL_30_MIN },
      baseTime + TTL_30_MIN,
    );

    expect(emitExpired).toHaveBeenCalledTimes(1);
  });

  it("resolves the TTL from the environment when no override is provided", async () => {
    const intent = await createPendingIntent(SLOT_1);
    const previous = process.env.EXPIRE_BOOKING_INTENTS_TTL_MS;
    process.env.EXPIRE_BOOKING_INTENTS_TTL_MS = String(60 * 1000);

    try {
      // 30 min elapses → way past the 1-minute env TTL.
      const result = await expireBookingIntentsOnce(
        { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
        {},
        baseTime + TTL_30_MIN,
      );
      expect(result.expiredCount).toBe(1);
      expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
    } finally {
      if (previous === undefined) {
        delete process.env.EXPIRE_BOOKING_INTENTS_TTL_MS;
      } else {
        process.env.EXPIRE_BOOKING_INTENTS_TTL_MS = previous;
      }
    }
  });

  it("falls back to defaults when env values are empty or invalid", async () => {
    const intent = await createPendingIntent(SLOT_1);
    const previousTtl = process.env.EXPIRE_BOOKING_INTENTS_TTL_MS;
    const previousBatch = process.env.EXPIRE_BOOKING_INTENTS_BATCH_SIZE;
    const previousSafety = process.env.EXPIRE_BOOKING_INTENTS_SAFETY_THRESHOLD;
    const previousInterval = process.env.EXPIRE_BOOKING_INTENTS_INTERVAL_MS;

    process.env.EXPIRE_BOOKING_INTENTS_TTL_MS = "not-a-number";
    process.env.EXPIRE_BOOKING_INTENTS_BATCH_SIZE = "";
    process.env.EXPIRE_BOOKING_INTENTS_SAFETY_THRESHOLD = "0";
    process.env.EXPIRE_BOOKING_INTENTS_INTERVAL_MS = "-5";

    try {
      // Invalid TTL falls back to the 30-minute default: createdAt === cutoff,
      // so the intent is stale at exactly the boundary.
      const result = await expireBookingIntentsOnce(
        { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
        {},
        baseTime + TTL_30_MIN,
      );
      expect(result.expiredCount).toBe(1);
      expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
    } finally {
      if (previousTtl === undefined) {
        delete process.env.EXPIRE_BOOKING_INTENTS_TTL_MS;
      } else {
        process.env.EXPIRE_BOOKING_INTENTS_TTL_MS = previousTtl;
      }
      if (previousBatch === undefined) {
        delete process.env.EXPIRE_BOOKING_INTENTS_BATCH_SIZE;
      } else {
        process.env.EXPIRE_BOOKING_INTENTS_BATCH_SIZE = previousBatch;
      }
      if (previousSafety === undefined) {
        delete process.env.EXPIRE_BOOKING_INTENTS_SAFETY_THRESHOLD;
      } else {
        process.env.EXPIRE_BOOKING_INTENTS_SAFETY_THRESHOLD = previousSafety;
      }
      if (previousInterval === undefined) {
        delete process.env.EXPIRE_BOOKING_INTENTS_INTERVAL_MS;
      } else {
        process.env.EXPIRE_BOOKING_INTENTS_INTERVAL_MS = previousInterval;
      }
    }
  });

  it("reads all worker config values from the environment", async () => {
    await createPendingIntent(SLOT_1);
    const previous = {
      ttl: process.env.EXPIRE_BOOKING_INTENTS_TTL_MS,
      batch: process.env.EXPIRE_BOOKING_INTENTS_BATCH_SIZE,
      safety: process.env.EXPIRE_BOOKING_INTENTS_SAFETY_THRESHOLD,
      interval: process.env.EXPIRE_BOOKING_INTENTS_INTERVAL_MS,
    };

    process.env.EXPIRE_BOOKING_INTENTS_TTL_MS = "60000";
    process.env.EXPIRE_BOOKING_INTENTS_BATCH_SIZE = "50";
    process.env.EXPIRE_BOOKING_INTENTS_SAFETY_THRESHOLD = "500";
    process.env.EXPIRE_BOOKING_INTENTS_INTERVAL_MS = "5000";

    try {
      const result = await expireBookingIntentsOnce(
        { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
        {},
        baseTime + TTL_30_MIN,
      );
      // TTL of 60s makes the intent (created at baseTime) deeply stale.
      expect(result.expiredCount).toBe(1);
    } finally {
      if (previous.ttl === undefined) {
        delete process.env.EXPIRE_BOOKING_INTENTS_TTL_MS;
      } else {
        process.env.EXPIRE_BOOKING_INTENTS_TTL_MS = previous.ttl;
      }
      if (previous.batch === undefined) {
        delete process.env.EXPIRE_BOOKING_INTENTS_BATCH_SIZE;
      } else {
        process.env.EXPIRE_BOOKING_INTENTS_BATCH_SIZE = previous.batch;
      }
      if (previous.safety === undefined) {
        delete process.env.EXPIRE_BOOKING_INTENTS_SAFETY_THRESHOLD;
      } else {
        process.env.EXPIRE_BOOKING_INTENTS_SAFETY_THRESHOLD = previous.safety;
      }
      if (previous.interval === undefined) {
        delete process.env.EXPIRE_BOOKING_INTENTS_INTERVAL_MS;
      } else {
        process.env.EXPIRE_BOOKING_INTENTS_INTERVAL_MS = previous.interval;
      }
    }
  });

  it("supports repositories whose findStalePendingIntents returns a Promise", async () => {
    class AsyncFindRepo extends InMemoryBookingIntentRepository {
      async findStalePendingIntents(cutoffMs: number, limit: number) {
        return super.findStalePendingIntents(cutoffMs, limit);
      }
    }

    const asyncRepo = new AsyncFindRepo();
    const service = new BookingIntentService(
      asyncRepo,
      slotRepo,
      () => new Date(baseTime).toISOString(),
    );
    const intent = await service.createIntent(
      { slotId: SLOT_1 },
      { userId: "customer-1", role: "customer" },
    );

    const result = await expireBookingIntentsOnce(
      { bookingIntentRepository: asyncRepo, bookingIntentService: service },
      { ttlMs: TTL_30_MIN },
      baseTime + TTL_30_MIN,
    );

    expect(result.expiredCount).toBe(1);
    expect(asyncRepo.findById(intent.id)?.status).toBe("expired");
  });

  it("managed worker ignores duplicate start calls", async () => {
    const intent = await createPendingIntent(SLOT_1);
    jest.useRealTimers();

    const worker = createExpireBookingIntentsWorker(
      { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
      { ttlMs: 1, intervalMs: 1000 },
    );

    worker.start();
    worker.start(); // second start is a no-op
    let result = worker.getLastResult();
    for (let i = 0; i < 20 && result === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      result = worker.getLastResult();
    }
    worker.stop();

    expect(result?.expiredCount).toBe(1);
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
  });

  it("stops gracefully when aborted mid-run", async () => {
    const intent = await createPendingIntent(SLOT_1);
    jest.setSystemTime(baseTime + 1_000_000);

    const abortController = new AbortController();
    const workerPromise = runExpireBookingIntentsWorker(
      abortController.signal,
      { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
      { intervalMs: 1000, ttlMs: 1 },
    );

    await Promise.resolve();
    abortController.abort();
    await expect(workerPromise).resolves.toBeUndefined();
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
  });

  it("aborts the worker loop while it is sleeping between sweeps", async () => {
    const intent = await createPendingIntent(SLOT_1);
    jest.setSystemTime(baseTime + 1_000_000);

    const abortController = new AbortController();
    const workerPromise = runExpireBookingIntentsWorker(
      abortController.signal,
      { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
      { intervalMs: 1000, ttlMs: 1 },
    );

    // Flush the microtask queue so the first sweep completes and the loop
    // reaches its sleep between sweeps, then abort mid-sleep.
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
    abortController.abort();
    await expect(workerPromise).resolves.toBeUndefined();
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
  });

  it("managed worker records the last sweep result and can be stopped", async () => {
    const intent = await createPendingIntent(SLOT_1);
    // Use real timers for the loop/poll so Date.now() is far past the intent's
    // creation time (making it stale) and setTimeout callbacks actually fire.
    jest.useRealTimers();

    const worker = createExpireBookingIntentsWorker(
      { bookingIntentRepository: bookingIntentRepo, bookingIntentService },
      { ttlMs: 1, intervalMs: 1000 },
    );

    worker.start();
    let result = worker.getLastResult();
    for (let i = 0; i < 20 && result === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      result = worker.getLastResult();
    }
    worker.stop();

    expect(result?.expiredCount).toBe(1);
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
  });

  it("falls back to default config when no overrides or clock are supplied", async () => {
    const intent = await createPendingIntent(SLOT_1);
    // Fake clock is frozen at baseTime, so the default 30-minute TTL means the
    // intent (created at baseTime) is still fresh and must not be expired.
    const result = await expireBookingIntentsOnce({
      bookingIntentRepository: bookingIntentRepo,
      bookingIntentService,
    });

    expect(result.expiredCount).toBe(0);
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("pending");
  });

  it("worker loop uses default config when none is supplied", async () => {
    const abortController = new AbortController();
    abortController.abort();

    // Already-aborted signal: the loop never sweeps and resolves immediately.
    const workerPromise = runExpireBookingIntentsWorker(abortController.signal, {
      bookingIntentRepository: bookingIntentRepo,
      bookingIntentService,
    });

    await expect(workerPromise).resolves.toBeUndefined();
  });

  it("managed worker uses default config and stops cleanly when aborted mid-sweep", async () => {
    const intent = await createPendingIntent(SLOT_1);
    // Default config (30-minute TTL): the intent is fresh at the frozen clock,
    // so a completed sweep reports zero expirations.
    const worker = createExpireBookingIntentsWorker({
      bookingIntentRepository: bookingIntentRepo,
      bookingIntentService,
    });

    worker.start();
    worker.stop(); // abort lands while the first sweep is still in flight

    // Flush the microtasks so the in-flight sweep and loop teardown complete.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    const result = worker.getLastResult();
    expect(result?.expiredCount).toBe(0);
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("pending");
  });
});
