// @ts-nocheck
import { describe, expect, it, beforeEach, jest } from "@jest/globals";
import { BookingIntentService, BookingIntentError } from "../booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../booking-intent-repository.js";
import { InMemorySlotRepository } from "../../slots/slot-repository.js";
import {
  SupplierBookingCapService,
  SupplierDailyCapExceededError,
  type RedisClient,
} from "../../../services/supplierCap.js";

// The real rrule dependency does not load under this jest ESM setup (pre-existing
// "Invalid RRULE format" failure in recurring-booking.test.ts), so stub the
// recurrence expansion and focus on the cap behaviour in the loop. The factory
// is self-contained so jest can apply it to the service's dynamic import().
jest.unstable_mockModule("../../../services/recurrenceService.js", () => ({
  RecurrenceError: class RecurrenceError extends Error {},
  expandRRule: (rrule: string) => {
    const dtstart = rrule.match(/DTSTART(?:;[^:]*)?:(\d{8})T(\d{6})Z/);
    const count = Number(rrule.match(/COUNT=(\d+)/)?.[1] ?? 0);
    const start = dtstart
      ? new Date(
          `${dtstart[1].slice(0, 4)}-${dtstart[1].slice(4, 6)}-${dtstart[1].slice(6, 8)}T${dtstart[2].slice(0, 2)}:${dtstart[2].slice(2, 4)}:${dtstart[2].slice(4, 6)}.000Z`,
        )
      : new Date();
    return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * 7 * 86_400_000));
  },
}));

class FakeRedisClient implements RedisClient {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const next = (parseInt(this.store.get(key) ?? "0", 10) || 0) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async expire(): Promise<unknown> {
    return 1;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace("*", "");
    return Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async quit(): Promise<unknown> {
    return "OK";
  }
}

const ACTOR = { userId: "buyer-1", role: "customer", claims: {} };

function aliceSlots() {
  return [
    {
      id: "slot-a-1",
      professional: "alice",
      startTime: 1_900_000_000_000,
      endTime: 1_900_000_360_000,
      bookable: true,
    },
    {
      id: "slot-a-2",
      professional: "alice",
      startTime: 1_900_000_720_000,
      endTime: 1_900_001_080_000,
      bookable: true,
    },
  ];
}

describe("BookingIntentService supplier daily cap", () => {
  let capService: SupplierBookingCapService;
  let redis: FakeRedisClient;

  beforeEach(() => {
    redis = new FakeRedisClient();
    capService = new SupplierBookingCapService({
      getRedis: () => redis,
      nowIso: () => "2026-07-31T12:00:00.000Z",
      auditLogger: { log: async () => {} } as any,
    });
  });

  it("enforces the cap across different slots of the same supplier", async () => {
    await capService.setOverride("alice", 1, "admin");
    const service = new BookingIntentService(
      new InMemoryBookingIntentRepository(),
      new InMemorySlotRepository(aliceSlots()),
      () => "2026-07-31T12:00:00.000Z",
      () => 1_900_000_000_000,
      undefined,
      undefined,
      capService,
    );

    const first = await service.createIntent({ slotId: "slot-a-1" }, ACTOR as any);
    expect(first.professional).toBe("alice");

    await expect(service.createIntent({ slotId: "slot-a-2" }, ACTOR as any)).rejects.toBeInstanceOf(
      SupplierDailyCapExceededError,
    );

    try {
      await service.createIntent({ slotId: "slot-a-2" }, ACTOR as any);
    } catch (error: any) {
      expect(error.statusCode).toBe(429);
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.usage).toMatchObject({ supplierId: "alice", used: 3, cap: 1 });
    }
  });

  it("fails open when the cap store is unavailable (Redis not configured)", async () => {
    const service = new BookingIntentService(
      new InMemoryBookingIntentRepository(),
      new InMemorySlotRepository(aliceSlots()),
      () => "2026-07-31T12:00:00.000Z",
      () => 1_900_000_000_000,
      undefined,
      undefined,
      new SupplierBookingCapService({ getRedis: () => null }),
    );

    const intent = await service.createIntent({ slotId: "slot-a-1" }, ACTOR as any);
    expect(intent.slotId).toBe("slot-a-1");
  });

  it("records capped-out occurrences as failures in the recurring report", async () => {
    await capService.setOverride("alice", 1, "admin");

    const dt1 = new Date("2026-01-05T10:00:00.000Z").getTime();
    const dt2 = new Date("2026-01-12T10:00:00.000Z").getTime();
    const slotRepo = new InMemorySlotRepository([
      {
        id: "r-slot-1",
        professional: "alice",
        startTime: dt1,
        endTime: dt1 + 3_600_000,
        bookable: true,
      },
      {
        id: "r-slot-2",
        professional: "alice",
        startTime: dt2,
        endTime: dt2 + 3_600_000,
        bookable: true,
      },
    ]);

    const service = new BookingIntentService(
      new InMemoryBookingIntentRepository(),
      slotRepo,
      () => "2026-01-01T00:00:00.000Z",
      () => dt1,
      undefined,
      undefined,
      capService,
    );

    const report = await service.createRecurringIntents(
      { rrule: "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=2;BYDAY=MO" },
      ACTOR as any,
    );

    expect(report.successes).toHaveLength(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].reason).toBe("Daily booking cap reached for this supplier");
  });

  it("keeps throwing other booking errors unrelated to the cap", async () => {
    await capService.setOverride("alice", 100, "admin");
    const service = new BookingIntentService(
      new InMemoryBookingIntentRepository(),
      new InMemorySlotRepository(aliceSlots()),
      () => "2026-07-31T12:00:00.000Z",
      () => 1_900_000_000_000,
      undefined,
      undefined,
      capService,
    );

    await expect(service.createIntent({ slotId: "missing-slot" }, ACTOR as any)).rejects.toEqual(
      expect.any(BookingIntentError),
    );
  });
});
