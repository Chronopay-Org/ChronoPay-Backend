/**
 * RecurringBookingRulesEngine tests.
 *
 * NOTE: TZID-based DST assertions require a UTC runtime (rrule resolves a
 * TZID anchor through the runtime timezone). CI runs on ubuntu-latest (UTC).
 */
import {
  RecurringBookingRulesEngine,
  RecurringBookingRulesError,
  BundleNotTransferableError,
  RECURRING_BOOKING_MAX_OCCURRENCES,
} from "../schedulingService.js";
import {
  InMemoryBookingIntentRepository,
  type BookingIntentRecord,
} from "../../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository, type SlotRecord } from "../../modules/slots/slot-repository.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const RULE_DAILY_3 = "DTSTART:20260105T100000Z\nRRULE:FREQ=DAILY;COUNT=3";
const T0 = Date.UTC(2026, 0, 5, 10, 0, 0); // 2026-01-05T10:00:00Z

function slotAt(
  id: string,
  professional: string,
  startTime: number,
  extra: Partial<SlotRecord> = {},
): SlotRecord {
  return { id, professional, startTime, endTime: startTime + HOUR_MS, bookable: true, ...extra };
}

function threeDailySlots(professional = "alice"): SlotRecord[] {
  return [
    slotAt("slot-1", professional, T0),
    slotAt("slot-2", professional, T0 + DAY_MS),
    slotAt("slot-3", professional, T0 + 2 * DAY_MS),
  ];
}

function makeEngine(
  options: Partial<ConstructorParameters<typeof RecurringBookingRulesEngine>[0]> = {},
) {
  const slotRepository = options.slotRepository ?? new InMemorySlotRepository(threeDailySlots());
  const bookingIntentRepository =
    options.bookingIntentRepository ?? new InMemoryBookingIntentRepository();
  return new RecurringBookingRulesEngine({
    slotRepository,
    bookingIntentRepository,
    now: () => "2026-01-01T00:00:00.000Z",
    ...options,
  });
}

const actor = { userId: "buyer-1", role: "customer", claims: {} };

describe("RecurringBookingRulesEngine", () => {
  describe("RRULE parsing / validation contract", () => {
    it("rejects empty and whitespace-only rules", () => {
      const engine = makeEngine();
      expect(() => engine.validateRRule("")).toThrow(RecurringBookingRulesError);
      expect(() => engine.validateRRule("   ")).toThrow(/non-empty/);
    });

    it("rejects non-string rules", () => {
      const engine = makeEngine();
      expect(() => engine.validateRRule(123 as never)).toThrow(/non-empty string/);
    });

    it("rejects unbounded rules (no COUNT or UNTIL)", () => {
      const engine = makeEngine();
      expect(() => engine.validateRRule("FREQ=WEEKLY;BYDAY=MO")).toThrow(/Unbounded/);
    });

    it("rejects malformed rule text", () => {
      const engine = makeEngine();
      expect(() => engine.validateRRule("INVALID=FORMAT;COUNT=5")).toThrow(
        RecurringBookingRulesError,
      );
    });

    it("rejects non-positive INTERVAL", () => {
      const engine = makeEngine();
      expect(() =>
        engine.validateRRule("DTSTART:20260101T100000Z\nRRULE:FREQ=DAILY;INTERVAL=0;COUNT=5"),
      ).toThrow(RecurringBookingRulesError);
    });

    it("rejects rules that expand beyond the safe maximum", () => {
      const engine = makeEngine();
      expect(() =>
        engine.validateRRule("DTSTART:20260101T100000Z\nRRULE:FREQ=DAILY;COUNT=201"),
      ).toThrow(/more than/);
      expect(RECURRING_BOOKING_MAX_OCCURRENCES).toBe(200);
    });

    it("rejects ambiguous floating DTSTART without explicit offset or TZID", () => {
      const engine = makeEngine();
      expect(() => engine.validateRRule("DTSTART:20261101T013000\nFREQ=DAILY;COUNT=3")).toThrow(
        /explicit timezone offset/,
      );
    });

    it("accepts bounded Z-anchored and TZID-anchored rules", () => {
      const engine = makeEngine();
      expect(() => engine.validateRRule(RULE_DAILY_3)).not.toThrow();
      expect(() =>
        engine.validateRRule("DTSTART;TZID=America/New_York:20261101T013000\nFREQ=DAILY;COUNT=3"),
      ).not.toThrow();
    });

    it("expands bounded rules into sorted, de-duplicated occurrences", () => {
      const engine = makeEngine();
      const occ = engine.expand("DTSTART:20260105T100000Z\nRRULE:FREQ=DAILY;COUNT=3");
      expect(occ).toHaveLength(3);
      expect(occ.map((d) => d.getTime())).toEqual([T0, T0 + DAY_MS, T0 + 2 * DAY_MS]);
    });
  });

  describe("materialization happy path", () => {
    it("creates one pending intent per occurrence and reserves each slot", async () => {
      const engine = makeEngine();
      const report = await engine.createRecurringBookings(RULE_DAILY_3, actor, {
        note: "every weekday",
      });

      expect(report).toEqual({ successes: expect.any(Array), failures: expect.any(Array) });
      expect(report.successes).toHaveLength(3);
      expect(report.failures).toHaveLength(0);

      const first = report.successes[0];
      expect(first).toMatchObject({
        slotId: "slot-1",
        customerId: "buyer-1",
        professional: "alice",
        status: "pending",
        startTime: T0,
        endTime: T0 + HOUR_MS,
        note: "every weekday",
      });
      expect(first.id).toBeDefined();

      const repo = new InMemorySlotRepository(threeDailySlots());
      for (const success of report.successes) {
        const slot = success.slotId;
        expect(repo.findById(slot)).toBeDefined();
      }
    }, 10000);

    it("reserves every materialized slot (bookable flips to false)", async () => {
      const slotRepository = new InMemorySlotRepository(threeDailySlots());
      const engine = makeEngine({ slotRepository });
      expect(slotRepository.findById("slot-1")!.bookable).toBe(true);

      await engine.createRecurringBookings(RULE_DAILY_3, actor);
      expect(slotRepository.findById("slot-1")!.bookable).toBe(false);
      expect(slotRepository.findById("slot-2")!.bookable).toBe(false);
      expect(slotRepository.findById("slot-3")!.bookable).toBe(false);
    });
  });

  describe("partial-success reporting", () => {
    it("surfaces failures when some occurrences have no matching slot", async () => {
      const slotRepository = new InMemorySlotRepository([slotAt("slot-1", "alice", T0)]);
      const engine = makeEngine({ slotRepository });

      const report = await engine.createRecurringBookings(RULE_DAILY_3, actor);
      expect(report.successes).toHaveLength(1);
      expect(report.failures).toHaveLength(2);
      expect(report.failures[0]).toEqual({
        date: new Date(T0 + DAY_MS).toISOString(),
        reason: "No available slot at this time",
      });
      expect(report.failures[1].reason).toBe("No available slot at this time");
    });

    it("rejects booking the buyer's own slot without failing the batch", async () => {
      const slotRepository = new InMemorySlotRepository([slotAt("slot-1", "buyer-1", T0)]);
      const engine = makeEngine({ slotRepository });

      const report = await engine.createRecurringBookings(RULE_DAILY_3, actor);
      expect(report.successes).toHaveLength(0);
      expect(report.failures[0].reason).toBe("Cannot book your own slot");
    });

    it("rejects non-transferable bundles without failing the batch", async () => {
      const engine = makeEngine({
        assertBundleTransferable: () => {
          throw new BundleNotTransferableError("bundle-9");
        },
      });
      const report = await engine.createRecurringBookings(RULE_DAILY_3, actor);
      expect(report.successes).toHaveLength(0);
      expect(report.failures[0].reason).toMatch(/not transferable/i);
    });

    it("propagates unexpected authorization errors instead of swallowing them", async () => {
      const engine = makeEngine({
        assertBundleTransferable: () => {
          throw new Error("policy service down");
        },
      });
      await expect(engine.createRecurringBookings(RULE_DAILY_3, actor)).rejects.toThrow(
        "policy service down",
      );
    });
  });

  describe("duplicate / retry safety", () => {
    it("rejects occurrences the buyer already holds for the same slot", async () => {
      const bookingIntentRepository = new InMemoryBookingIntentRepository();
      await bookingIntentRepository.create({
        slotId: "slot-1",
        professional: "alice",
        customerId: "buyer-1",
        startTime: T0,
        endTime: T0 + HOUR_MS,
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const engine = makeEngine({ bookingIntentRepository });

      const report = await engine.createRecurringBookings(RULE_DAILY_3, actor);
      expect(report.failures[0].reason).toBe("Customer already has an intent for this slot");
      expect(report.successes).toHaveLength(2);
    });

    it("rejects occurrences whose slot already has another active intent", async () => {
      const bookingIntentRepository = new InMemoryBookingIntentRepository();
      await bookingIntentRepository.create({
        slotId: "slot-2",
        professional: "alice",
        customerId: "buyer-2",
        startTime: T0 + DAY_MS,
        endTime: T0 + DAY_MS + HOUR_MS,
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const engine = makeEngine({ bookingIntentRepository });

      const report = await engine.createRecurringBookings(RULE_DAILY_3, actor);
      expect(report.failures[0].reason).toBe("Slot already has active booking intent");
      expect(report.successes).toHaveLength(2);
      expect(report.successes[0].slotId).toBe("slot-1");
    });

    it("is safe to resubmit: second run produces zero successes and clear failures", async () => {
      const engine = makeEngine();
      const first = await engine.createRecurringBookings(RULE_DAILY_3, actor);
      expect(first.successes).toHaveLength(3);

      const second = await engine.createRecurringBookings(RULE_DAILY_3, actor);
      expect(second.successes).toHaveLength(0);
      expect(second.failures).toHaveLength(3);
      // Slots were already reserved by the first run, so they read as unavailable.
      expect(second.failures[0].reason).toBe("No available slot at this time");
    });
  });

  describe("failure recovery and atomicity", () => {
    it("releases a reserved slot when intent persistence fails (compensating action)", async () => {
      class FlakyRepository extends InMemoryBookingIntentRepository {
        failNext: number | null = null;
        override async create(
          intent: Omit<BookingIntentRecord, "id">,
        ): Promise<BookingIntentRecord> {
          if (this.failNext !== null) {
            const remaining = this.failNext;
            this.failNext = null;
            if (remaining === 1) throw new Error("db outage");
          }
          return super.create(intent);
        }
      }

      const slotRepository = new InMemorySlotRepository(threeDailySlots());
      const bookingIntentRepository = new FlakyRepository();
      bookingIntentRepository.failNext = 1;
      const engine = makeEngine({ slotRepository, bookingIntentRepository });

      const report = await engine.createRecurringBookings(RULE_DAILY_3, actor);

      // First occurrence failed AND the reserved slot was released.
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0].reason).toMatch(/Failed to create booking intent: db outage/);
      expect(report.successes).toHaveLength(2);
      expect(slotRepository.findById("slot-1")!.bookable).toBe(true);
      expect(slotRepository.findById("slot-2")!.bookable).toBe(false);

      // A retry is able to book the recovered slot.
      const retry = await engine.createRecurringBookings(RULE_DAILY_3, actor);
      expect(retry.successes).toHaveLength(1);
      expect(retry.successes[0].slotId).toBe("slot-1");
      expect(slotRepository.findById("slot-1")!.bookable).toBe(false);
    });

    it("never leaves a slot double-booked under concurrent submissions", async () => {
      const slotRepository = new InMemorySlotRepository(threeDailySlots());
      const bookingIntentRepository = new InMemoryBookingIntentRepository();
      const engine = makeEngine({ slotRepository, bookingIntentRepository });

      const [reportA, reportB] = await Promise.all([
        engine.createRecurringBookings(RULE_DAILY_3, actor),
        engine.createRecurringBookings(RULE_DAILY_3, actor),
      ]);

      const allSuccesses = [...reportA.successes, ...reportB.successes];
      // Three slots, three unique booking intents — no double booking.
      expect(allSuccesses).toHaveLength(3);
      const reservedSlotIds = allSuccesses.map((s) => s.slotId);
      expect(new Set(reservedSlotIds).size).toBe(3);
      for (const id of ["slot-1", "slot-2", "slot-3"]) {
        expect(slotRepository.findById(id)!.bookable).toBe(false);
      }

      // Who won is irrelevant; the loser(s) reported a clean conflict.
      expect([...reportA.failures, ...reportB.failures].length).toBe(3);
      for (const failure of [...reportA.failures, ...reportB.failures]) {
        expect(failure.reason).not.toMatch(/Internal server error/);
      }
    });
  });

  describe("DST behavior", () => {
    it("keeps a Z-anchored series at stable absolute instants across a fall-back", () => {
      const engine = makeEngine();
      const occ = engine.expand("DTSTART:20261030T100000Z\nRRULE:FREQ=DAILY;COUNT=3");
      for (const d of occ) {
        expect(d.toISOString().slice(11, 19)).toBe("10:00:00");
      }
      // Even spacing: offsets do not drift because occurrences are absolute.
      expect(occ[1].getTime() - occ[0].getTime()).toBe(DAY_MS);
      expect(occ[2].getTime() - occ[1].getTime()).toBe(DAY_MS);
    });

    it("preserves local wall-clock time for a TZID-anchored series across the fall-back", () => {
      const engine = makeEngine();
      const occ = engine.expand(
        "DTSTART;TZID=America/New_York:20261030T100000\nRRULE:FREQ=DAILY;COUNT=3",
      );

      const localHms = (d: Date) =>
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        }).format(d);

      // Every occurrence fires at 10:00 local — the DST fall-back on
      // 2026-11-01 does not shift the buyer's local appointment time.
      for (const d of occ) {
        expect(localHms(d)).toBe("10:00:00");
      }

      // On the transition day the absolute instant is pushed by one real hour,
      // so the wall clock stays put: Oct31 14:00Z -> Nov1 15:00Z.
      expect(occ[0].toISOString()).toBe("2026-10-30T14:00:00.000Z");
      expect(occ[1].toISOString()).toBe("2026-10-31T14:00:00.000Z");
      expect(occ[2].toISOString()).toBe("2026-11-01T15:00:00.000Z");
      expect(occ[2].getTime() - occ[1].getTime()).toBe(25 * HOUR_MS);
    });

    it("materializes TZID-anchored occurrences against the correctly resolved instants", async () => {
      const t0 = Date.UTC(2026, 9, 30, 14, 0, 0); // Oct 30 10:00 EDT
      const t1 = Date.UTC(2026, 9, 31, 14, 0, 0); // Oct 31 10:00 EDT
      const t2 = Date.UTC(2026, 10, 1, 15, 0, 0); // Nov 1 10:00 EST
      const slotRepository = new InMemorySlotRepository([
        slotAt("slot-1", "alice", t0),
        slotAt("slot-2", "alice", t1),
        slotAt("slot-3", "alice", t2),
      ]);
      const engine = makeEngine({ slotRepository });

      const report = await engine.createRecurringBookings(
        "DTSTART;TZID=America/New_York:20261030T100000\nRRULE:FREQ=DAILY;COUNT=3",
        actor,
      );

      expect(report.successes).toHaveLength(3);
      expect(report.successes.map((s) => s.startTime)).toEqual([t0, t1, t2]);
      expect(report.failures).toHaveLength(0);
    });
  });

  describe("boundary inputs", () => {
    it("handles a single-occurrence rule", async () => {
      const engine = makeEngine();
      const report = await engine.createRecurringBookings(
        "DTSTART:20260105T100000Z\nRRULE:FREQ=DAILY;COUNT=1",
        actor,
      );
      expect(report.successes).toHaveLength(1);
      expect(report.failures).toHaveLength(0);
    });

    it("returns an empty (not errored) report when EXDATEs remove every occurrence", () => {
      const engine = makeEngine();
      const rrule =
        "DTSTART:20260105T100000Z\nRRULE:FREQ=DAILY;COUNT=2\n" +
        "EXDATE:20260105T100000Z,20260106T100000Z";
      const occ = engine.expand(rrule);
      expect(occ).toHaveLength(0);
    });
  });
});
