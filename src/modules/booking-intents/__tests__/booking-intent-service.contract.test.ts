/**
 * Focused contract suite for `src/modules/booking-intents/booking-intent-service.ts`.
 *
 * It pins the public surface named in the issue:
 *   - `CreateBookingIntentInput`  → `parseCreateBookingIntentBody` / `createIntent` / `createIntentTraced`
 *   - `CreateRecurringBookingInput` → `parseCreateBookingIntentBody` / `createRecurringIntents`
 *   - `AutoRefundResult`          → `autoRefundHold`
 *
 * plus representative invalid inputs and every primary state transition.
 *
 * Determinism: the service clock is injected (`now` / `nowMs`) and `Date.now`
 * is pinned for the few collaborators that read the ambient clock
 * (`SchedulingService.reserveSlot`, `CancellationPolicyService` inside
 * `previewCancel`). No wall-clock, network or database dependency is used.
 */

import { jest } from "@jest/globals";
import {
  BookingIntentError,
  BookingIntentService,
  SLOT_ID_PATTERN,
  parseCreateBookingIntentBody,
  type AutoRefundResult,
  type CreateBookingIntentInput,
  type CreateRecurringBookingInput,
} from "../booking-intent-service.js";
import {
  InMemoryBookingIntentRepository,
  type BookingIntentRecord,
  type BookingIntentStatus,
} from "../booking-intent-repository.js";
import {
  InMemorySlotRepository,
  type SlotPricingStrategy,
  type SlotRecord,
} from "../../slots/slot-repository.js";
import type { AuthContext } from "../../../middleware/auth.js";
import type { VerifiedJwtPayload } from "../../../utils/jwt.js";
import { ERROR_CODES } from "../../../errors/errorCodes.js";
import { addSpanExporter, removeSpanExporter } from "../../../tracing/spanExporter.js";
import type { Span } from "../../../tracing/hooks.js";
import {
  _resetReputationEventStore,
  listReputationEvents,
} from "../../../services/reputationWriteAudit.js";
import type { FxRateProvider } from "../../../services/fxRateProvider.js";
import type { HoldFeePolicyRegistry } from "../../../services/holdFeePolicy.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Frozen clock used for every service instance built by {@link createFixture}. */
const NOW_MS = 1_900_000_000_000; // 2030-03-17T17:46:40.000Z
const NOW_ISO = new Date(NOW_MS).toISOString();
const HOUR_MS = 60 * 60 * 1000;

/** Slot starts 168 h out so the ≥7 d cancellation tier is selected. */
const SLOT_START_MS = NOW_MS + 168 * HOUR_MS;
const SLOT_END_MS = SLOT_START_MS + HOUR_MS;
const HOLD_DEADLINE_MS = NOW_MS + 30 * 60 * 1000;

const SLOT_ALICE = "slot-11111111-1111-4111-8111-111111111111";
const SLOT_BOB = "slot-22222222-2222-4222-8222-222222222222";

/** Recurring-booking occurrence anchors (both a Monday 12:00 UTC). */
const OCC_1_MS = 1_900_065_600_000; // 2030-03-18T12:00:00.000Z
const OCC_2_MS = 1_900_152_000_000; // 2030-03-19T12:00:00.000Z
const RRULE_DAILY_2 = "DTSTART:20300318T120000Z\nRRULE:FREQ=DAILY;COUNT=2";
const RRULE_DAILY_1 = "DTSTART:20300318T120000Z\nRRULE:FREQ=DAILY;COUNT=1";

const CLAIMS = {} as VerifiedJwtPayload;

function actor(userId: string, role: AuthContext["role"] = "customer"): AuthContext {
  return { userId, role, claims: CLAIMS };
}

const customer = actor("customer-1");
const otherCustomer = actor("customer-2");
const admin = actor("admin-1", "admin");
const alice = actor("alice", "professional");

const FIXED_PRICING: SlotPricingStrategy = {
  strategyId: "fixed",
  basePrice: 1000,
  capacity: 1,
  config: { strategy: "fixed" },
};

const DEMAND_PRICING: SlotPricingStrategy = {
  strategyId: "demand_based",
  basePrice: 1000,
  capacity: 2,
  config: { strategy: "demand_based", maxMultiplier: 2 },
};

function bookableSlot(overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    id: SLOT_ALICE,
    professional: "alice",
    startTime: SLOT_START_MS,
    endTime: SLOT_END_MS,
    bookable: true,
    ...overrides,
  };
}

function occurrenceSlot(startTime: number, overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    id: SLOT_ALICE,
    professional: "alice",
    startTime,
    endTime: startTime + HOUR_MS,
    bookable: true,
    ...overrides,
  };
}

function createFixture(
  slots: SlotRecord[] = [bookableSlot()],
  fxRateProvider?: FxRateProvider,
  holdFeeRegistry?: HoldFeePolicyRegistry,
) {
  const slotRepo = new InMemorySlotRepository(slots);
  const intentRepo = new InMemoryBookingIntentRepository();
  const service = new BookingIntentService(
    intentRepo,
    slotRepo,
    () => NOW_ISO,
    () => NOW_MS,
    undefined,
    holdFeeRegistry,
    fxRateProvider,
  );
  return { slotRepo, intentRepo, service };
}

function isBookable(slotRepo: InMemorySlotRepository, slotId: string): boolean {
  return slotRepo.findById(slotId)?.bookable === true;
}

function statusOf(intentRepo: InMemoryBookingIntentRepository, id: string): BookingIntentStatus | undefined {
  return intentRepo.findById(id)?.status;
}

/** Awaits `promise` and returns the thrown error, or undefined when it resolves. */
async function captureError(promise: Promise<unknown>): Promise<BookingIntentError | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err as BookingIntentError;
  }
}

/** Runs `fn` and returns the thrown error, or undefined when it does not throw. */
function captureSyncError(fn: () => unknown): BookingIntentError | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err as BookingIntentError;
  }
}

function seedIntent(
  intentRepo: InMemoryBookingIntentRepository,
  overrides: Partial<BookingIntentRecord> & Pick<BookingIntentRecord, "slotId" | "customerId">,
): Promise<BookingIntentRecord> {
  return intentRepo.create({
    professional: "alice",
    startTime: SLOT_START_MS,
    endTime: SLOT_END_MS,
    status: "pending",
    createdAt: NOW_ISO,
    bookingType: "standard",
    ...overrides,
  });
}

const fxProvider = (rate: number, onError?: () => never): FxRateProvider => ({
  getRate: async (base: string, target: string) => {
    void base;
    void target;
    if (onError) return onError();
    return rate;
  },
});

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW_MS);
  _resetReputationEventStore();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── parseCreateBookingIntentBody → CreateBookingIntentInput ──────────────────

describe("parseCreateBookingIntentBody — CreateBookingIntentInput", () => {
  it("accepts a minimal payload and leaves every optional field undefined", () => {
    const parsed = parseCreateBookingIntentBody({ slotId: SLOT_ALICE });

    expect(parsed).toEqual({ slotId: SLOT_ALICE });
    const input = parsed as CreateBookingIntentInput;
    expect(input.note).toBeUndefined();
    expect(input.bookingType).toBeUndefined();
    expect(input.holdDeadlineMs).toBeUndefined();
    expect(input.buyerCurrency).toBeUndefined();
  });

  it("normalises every optional CreateBookingIntentInput field", () => {
    const parsed = parseCreateBookingIntentBody({
      slotId: `  ${SLOT_ALICE}  `,
      note: "  bring water  ",
      bookingType: "refundable_hold",
      holdDeadlineMs: HOLD_DEADLINE_MS,
      buyerCurrency: "EUR",
    }) as CreateBookingIntentInput;

    expect(parsed).toEqual({
      slotId: SLOT_ALICE,
      note: "bring water",
      bookingType: "refundable_hold",
      holdDeadlineMs: HOLD_DEADLINE_MS,
      buyerCurrency: "EUR",
    });
  });

  it("strips control characters from the note", () => {
    const parsed = parseCreateBookingIntentBody({
      slotId: SLOT_ALICE,
      note: "clean\u0000\u0007me",
    }) as CreateBookingIntentInput;

    expect(parsed.note).toBe("cleanme");
  });

  it("accepts a note of exactly 500 characters (inclusive boundary)", () => {
    const note = "a".repeat(500);
    const parsed = parseCreateBookingIntentBody({ slotId: SLOT_ALICE, note }) as CreateBookingIntentInput;

    expect(parsed.note).toHaveLength(500);
  });

  it("accepts a holdDeadlineMs of 0 (inclusive boundary)", () => {
    const parsed = parseCreateBookingIntentBody({
      slotId: SLOT_ALICE,
      holdDeadlineMs: 0,
    }) as CreateBookingIntentInput;

    expect(parsed.holdDeadlineMs).toBe(0);
  });

  it("accepts an upper-case slot id because SLOT_ID_PATTERN is case-insensitive", () => {
    const upper = SLOT_ALICE.toUpperCase();
    expect(SLOT_ID_PATTERN.test(upper)).toBe(true);
    expect(parseCreateBookingIntentBody({ slotId: upper })).toEqual({ slotId: upper });
  });

  it.each(["USD", "EUR", "GBP", "XLM"] as const)("accepts the supported buyerCurrency %s", (currency) => {
    const parsed = parseCreateBookingIntentBody({
      slotId: SLOT_ALICE,
      buyerCurrency: currency,
    }) as CreateBookingIntentInput;

    expect(parsed.buyerCurrency).toBe(currency);
  });

  it.each([
    ["a non-object body", null, "Booking intent payload must be a JSON object."],
    ["undefined", undefined, "Booking intent payload must be a JSON object."],
    ["an array", [], "Booking intent payload must be a JSON object."],
    ["a string", "slot", "Booking intent payload must be a JSON object."],
    ["a number", 42, "Booking intent payload must be a JSON object."],
    ["a boolean", true, "Booking intent payload must be a JSON object."],
  ])("rejects %s", (_label, body, message) => {
    expect(() => parseCreateBookingIntentBody(body)).toThrow(new BookingIntentError(400, message));
  });

  it.each([
    ["an empty object", {}],
    ["a null slotId", { slotId: null }],
    ["a non-string slotId", { slotId: 42 }],
    ["an empty slotId", { slotId: "" }],
    ["a whitespace-only slotId", { slotId: "   " }],
  ])("rejects %s with 'slotId is required.'", (_label, body) => {
    expect(() => parseCreateBookingIntentBody(body)).toThrow(
      new BookingIntentError(400, "slotId is required."),
    );
  });

  it.each([
    ["a bare word", "nope"],
    ["a short prefix", "slot-123"],
    ["a truncated uuid", "slot-11111111-1111-4111-8111-11111111111"],
    ["an over-long uuid", "slot-11111111-1111-4111-8111-1111111111111"],
    ["non-hex characters", "slot-zzzzzzzz-1111-4111-8111-111111111111"],
    ["a missing prefix", "11111111-1111-4111-8111-111111111111"],
  ])("rejects %s as a malformed slot id", (_label, slotId) => {
    expect(SLOT_ID_PATTERN.test(slotId)).toBe(false);
    expect(() => parseCreateBookingIntentBody({ slotId })).toThrow(
      new BookingIntentError(400, "slotId format is invalid."),
    );
  });

  it.each([
    ["a number", 123],
    ["null", null],
    ["an object", { text: "hi" }],
    ["an array", ["hi"]],
  ])("rejects a note that is %s", (_label, note) => {
    expect(() => parseCreateBookingIntentBody({ slotId: SLOT_ALICE, note })).toThrow(
      new BookingIntentError(400, "note must be a string when provided."),
    );
  });

  it.each([
    ["whitespace only", "   "],
    ["control characters only", "\u0000\u0007"],
    ["a tab/newline mix that trims to empty", "\t\n\r "],
  ])("rejects a note that is %s", (_label, note) => {
    expect(() => parseCreateBookingIntentBody({ slotId: SLOT_ALICE, note })).toThrow(
      new BookingIntentError(400, "note cannot be empty when provided."),
    );
  });

  it("rejects a note longer than 500 characters", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: SLOT_ALICE, note: "a".repeat(501) })).toThrow(
      new BookingIntentError(400, "note must be 500 characters or fewer."),
    );
  });

  it.each([
    ["an unknown string", "premium"],
    ["the empty string", ""],
    ["a number", 1],
    ["null", null],
    ["an object", { type: "standard" }],
  ])("rejects bookingType %s", (_label, bookingType) => {
    expect(() => parseCreateBookingIntentBody({ slotId: SLOT_ALICE, bookingType })).toThrow(
      new BookingIntentError(400, "Invalid bookingType."),
    );
  });

  it.each(["standard", "refundable_hold"] as const)("accepts bookingType %s", (bookingType) => {
    const parsed = parseCreateBookingIntentBody({ slotId: SLOT_ALICE, bookingType }) as CreateBookingIntentInput;
    expect(parsed.bookingType).toBe(bookingType);
  });

  it.each([
    ["a numeric string", "1000"],
    ["null", null],
    ["NaN", Number.NaN],
    ["an object", { ms: 1000 }],
  ])("rejects holdDeadlineMs %s", (_label, holdDeadlineMs) => {
    expect(() => parseCreateBookingIntentBody({ slotId: SLOT_ALICE, holdDeadlineMs })).toThrow(
      new BookingIntentError(400, "holdDeadlineMs must be a valid number."),
    );
  });

  it.each([
    ["an unsupported code", "JPY"],
    ["a lowercase code", "usd"],
    ["a number", 840],
    ["null", null],
  ])("rejects buyerCurrency %s", (_label, buyerCurrency) => {
    expect(() => parseCreateBookingIntentBody({ slotId: SLOT_ALICE, buyerCurrency })).toThrow(
      new BookingIntentError(400, "Invalid buyerCurrency. Must be one of USD, EUR, GBP, XLM."),
    );
  });

  it("reports the buyerCurrency error before the slotId error (deterministic precedence)", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "!!!", buyerCurrency: "JPY" })).toThrow(
      new BookingIntentError(400, "Invalid buyerCurrency. Must be one of USD, EUR, GBP, XLM."),
    );
  });

  it("reports the bookingType error before the slotId error (deterministic precedence)", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "!!!", bookingType: "premium" })).toThrow(
      new BookingIntentError(400, "Invalid bookingType."),
    );
  });

  it("attaches a 400 status and BAD_REQUEST code to every rejection", () => {
    try {
      parseCreateBookingIntentBody({});
      throw new Error("parseCreateBookingIntentBody should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BookingIntentError);
      const error = err as BookingIntentError;
      expect(error.name).toBe("BookingIntentError");
      expect(error.status).toBe(400);
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe(ERROR_CODES.BAD_REQUEST.code);
      expect(error.isOperational).toBe(true);
    }
  });
});

// ─── parseCreateBookingIntentBody → CreateRecurringBookingInput ───────────────

describe("parseCreateBookingIntentBody — CreateRecurringBookingInput", () => {
  it("returns a CreateRecurringBookingInput when an rrule is supplied", () => {
    const parsed = parseCreateBookingIntentBody({
      rrule: `  ${RRULE_DAILY_1}  `,
      note: "  weekly  ",
      bookingType: "standard",
      holdDeadlineMs: HOLD_DEADLINE_MS,
      buyerCurrency: "GBP",
    }) as CreateRecurringBookingInput;

    expect(parsed).toEqual({
      rrule: RRULE_DAILY_1,
      note: "weekly",
      bookingType: "standard",
      holdDeadlineMs: HOLD_DEADLINE_MS,
      buyerCurrency: "GBP",
    });
    expect("slotId" in parsed).toBe(false);
  });

  it("treats the payload as recurring whenever an rrule is present, ignoring slotId", () => {
    const parsed = parseCreateBookingIntentBody({ rrule: RRULE_DAILY_1, slotId: "not-a-slot" });

    expect(parsed).toEqual({ rrule: RRULE_DAILY_1 });
  });

  it("leaves the optional recurring fields undefined when they are absent", () => {
    const parsed = parseCreateBookingIntentBody({ rrule: RRULE_DAILY_1 }) as CreateRecurringBookingInput;

    expect(parsed.note).toBeUndefined();
    expect(parsed.bookingType).toBeUndefined();
    expect(parsed.holdDeadlineMs).toBeUndefined();
    expect(parsed.buyerCurrency).toBeUndefined();
  });

  it("accepts a rule with no DTSTART line", () => {
    const rrule = "RRULE:FREQ=DAILY;COUNT=3";
    expect(parseCreateBookingIntentBody({ rrule })).toEqual({ rrule });
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
    ["an object", { freq: "DAILY" }],
  ])("rejects an rrule that is %s", (_label, rrule) => {
    expect(() => parseCreateBookingIntentBody({ rrule })).toThrow(
      new BookingIntentError(400, "rrule must be a non-empty string."),
    );
  });

  it("rejects a DTSTART without an explicit offset or TZID (ambiguous local time)", () => {
    expect(() =>
      parseCreateBookingIntentBody({ rrule: "DTSTART:20300318T120000\nRRULE:FREQ=DAILY;COUNT=2" }),
    ).toThrow(
      new BookingIntentError(
        400,
        "Ambiguous DTSTART: missing explicit timezone offset (Z or TZID)",
      ),
    );
  });

  it("accepts a Z-anchored DTSTART carrying parameters before the colon", () => {
    const rrule = "DTSTART;VALUE=DATE-TIME:20300318T120000Z\nRRULE:FREQ=DAILY;COUNT=2";
    expect(parseCreateBookingIntentBody({ rrule })).toEqual({ rrule });
  });

  it("accepts a TZID-anchored DTSTART without a trailing Z", () => {
    const rrule = "DTSTART;TZID=Europe/London:20300318T120000\nRRULE:FREQ=DAILY;COUNT=2";
    expect(parseCreateBookingIntentBody({ rrule })).toEqual({ rrule });
  });

  it("accepts CRLF line endings", () => {
    const rrule = "DTSTART:20300318T120000Z\r\nRRULE:FREQ=DAILY;COUNT=2";
    expect(parseCreateBookingIntentBody({ rrule })).toEqual({ rrule });
  });

  it("applies the same note rules in the recurring branch", () => {
    expect(() => parseCreateBookingIntentBody({ rrule: RRULE_DAILY_1, note: 7 })).toThrow(
      new BookingIntentError(400, "note must be a string when provided."),
    );
    expect(() => parseCreateBookingIntentBody({ rrule: RRULE_DAILY_1, note: "   " })).toThrow(
      new BookingIntentError(400, "note cannot be empty when provided."),
    );
    expect(() => parseCreateBookingIntentBody({ rrule: RRULE_DAILY_1, note: "a".repeat(501) })).toThrow(
      new BookingIntentError(400, "note must be 500 characters or fewer."),
    );
  });

  it("applies the same bookingType/holdDeadlineMs/buyerCurrency rules in the recurring branch", () => {
    expect(() => parseCreateBookingIntentBody({ rrule: RRULE_DAILY_1, bookingType: "premium" })).toThrow(
      new BookingIntentError(400, "Invalid bookingType."),
    );
    expect(() => parseCreateBookingIntentBody({ rrule: RRULE_DAILY_1, holdDeadlineMs: "soon" })).toThrow(
      new BookingIntentError(400, "holdDeadlineMs must be a valid number."),
    );
    expect(() => parseCreateBookingIntentBody({ rrule: RRULE_DAILY_1, buyerCurrency: "JPY" })).toThrow(
      new BookingIntentError(400, "Invalid buyerCurrency. Must be one of USD, EUR, GBP, XLM."),
    );
  });
});

// ─── createIntent(CreateBookingIntentInput) — success ─────────────────────────

describe("BookingIntentService.createIntent — CreateBookingIntentInput success paths", () => {
  it("creates a pending standard intent and reserves the slot", async () => {
    const { service, slotRepo } = createFixture();
    const input: CreateBookingIntentInput = { slotId: SLOT_ALICE, note: "hello" };

    const intent = await service.createIntent(input, customer);

    expect(intent.status).toBe("pending");
    expect(intent.bookingType).toBe("standard");
    expect(intent.slotId).toBe(SLOT_ALICE);
    expect(intent.professional).toBe("alice");
    expect(intent.customerId).toBe("customer-1");
    expect(intent.startTime).toBe(SLOT_START_MS);
    expect(intent.endTime).toBe(SLOT_END_MS);
    expect(intent.note).toBe("hello");
    expect(intent.createdAt).toBe(NOW_ISO);
    expect(intent.holdPlacedAt).toBeUndefined();
    expect(intent.holdUntilMs).toBeUndefined();
    expect(intent.refundMetadata).toBeUndefined();
    expect(isBookable(slotRepo, SLOT_ALICE)).toBe(false);
  });

  it("omits the note when the input does not carry one", async () => {
    const { service } = createFixture();

    const intent = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    expect(intent.note).toBeUndefined();
  });

  it("creates a hold_placed intent for bookingType refundable_hold", async () => {
    const { service, slotRepo } = createFixture();
    const input: CreateBookingIntentInput = {
      slotId: SLOT_ALICE,
      bookingType: "refundable_hold",
      holdDeadlineMs: HOLD_DEADLINE_MS,
    };

    const intent = await service.createIntent(input, customer);

    expect(intent.status).toBe("hold_placed");
    expect(intent.bookingType).toBe("refundable_hold");
    expect(intent.holdPlacedAt).toBe(NOW_ISO);
    expect(intent.holdUntilMs).toBe(HOLD_DEADLINE_MS);
    expect(isBookable(slotRepo, SLOT_ALICE)).toBe(false);
  });

  it("captures the cancellation and hold-fee policy snapshots at creation time", async () => {
    const { service } = createFixture();

    const intent = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    expect(intent.cancellationPolicySnapshot?.policyVersionId).toBe("v2-prorated");
    expect(intent.cancellationPolicySnapshot?.capturedAtMs).toBe(NOW_MS);
    expect(intent.holdFeePolicySnapshot).toEqual({
      supplierId: "alice",
      holdFeeCents: 0,
      capturedAtMs: NOW_MS,
    });
  });

  it("grandfathers a non-zero hold fee from the injected registry", async () => {
    const { service } = createFixture([bookableSlot()], undefined, {
      entries: { alice: { supplierId: "alice", holdFeeCents: 250, updatedAt: NOW_ISO } },
    });

    const intent = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    expect(intent.holdFeePolicySnapshot).toEqual({
      supplierId: "alice",
      holdFeeCents: 250,
      capturedAtMs: NOW_MS,
    });
  });

  it("snapshots the slot's fixed pricing strategy", async () => {
    const { service } = createFixture([bookableSlot({ pricingStrategy: FIXED_PRICING })]);

    const intent = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    expect(intent.pricingSnapshot).toEqual({
      strategyId: "fixed",
      resolvedPrice: 1000,
      basePrice: 1000,
      slotStartMs: SLOT_START_MS,
      nowMs: NOW_MS,
      activeBookings: 0,
      capacity: 1,
      config: { strategy: "fixed" },
    });
  });

  it("leaves pricingSnapshot undefined when the slot has no pricing strategy", async () => {
    const { service } = createFixture();

    const intent = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    expect(intent.pricingSnapshot).toBeUndefined();
  });

  it("counts only pending/confirmed intents of the same slot in the demand_based snapshot", async () => {
    const { service, intentRepo } = createFixture([
      bookableSlot({ pricingStrategy: DEMAND_PRICING }),
    ]);
    // A confirmed intent on the same slot counts as demand but does not block
    // a new buyer: `findBySlotId` only reports pending / hold_placed intents.
    const confirmed = await seedIntent(intentRepo, { slotId: SLOT_ALICE, customerId: "someone-else" });
    intentRepo.updateStatus(confirmed.id, "confirmed");
    // A terminal intent on the same slot must not be counted.
    const expired = await seedIntent(intentRepo, { slotId: SLOT_ALICE, customerId: "someone-else-2" });
    intentRepo.updateStatus(expired.id, "expired");

    const intent = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    expect(intent.pricingSnapshot?.activeBookings).toBe(1);
    // capacity 2, 1 active booking, maxMultiplier 2 → 1 + (1/2) * 1 = 1.5
    expect(intent.pricingSnapshot?.capacity).toBe(2);
    expect(intent.pricingSnapshot?.resolvedPrice).toBe(1500);
  });

  it("captures the FX rate when the slot is priced in another currency", async () => {
    const { service } = createFixture(
      [bookableSlot({ currency: "USD", amount_minor: 1000 })],
      fxProvider(0.92),
    );

    const intent = await service.createIntent(
      { slotId: SLOT_ALICE, buyerCurrency: "EUR" },
      customer,
    );

    expect(intent.fxRateSnapshot).toEqual({
      rate: 0.92,
      baseCurrency: "USD",
      targetCurrency: "EUR",
      capturedAtMs: NOW_MS,
    });
  });

  it("skips the FX lookup when the buyer does not request a currency", async () => {
    const { service } = createFixture(
      [bookableSlot({ currency: "USD", amount_minor: 1000 })],
      fxProvider(0.92),
    );

    const intent = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    expect(intent.fxRateSnapshot).toBeUndefined();
  });

  it("skips the FX lookup when the slot has no currency", async () => {
    const { service } = createFixture([bookableSlot()], fxProvider(0.92));

    const intent = await service.createIntent(
      { slotId: SLOT_ALICE, buyerCurrency: "EUR" },
      customer,
    );

    expect(intent.fxRateSnapshot).toBeUndefined();
  });

  it("releases the reservation when a valid-but-unexpired bundle is used", async () => {
    const { service, slotRepo } = createFixture([bookableSlot({ validUntil: NOW_MS + 1000 })]);

    const intent = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    expect(intent.status).toBe("pending");
    expect(isBookable(slotRepo, SLOT_ALICE)).toBe(false);
  });
});

// ─── createIntent(CreateBookingIntentInput) — failure ─────────────────────────

describe("BookingIntentService.createIntent — failure paths", () => {
  it("throws 404 when the slot does not exist", async () => {
    const { service } = createFixture();

    await expect(service.createIntent({ slotId: SLOT_BOB }, customer)).rejects.toThrow(
      new BookingIntentError(404, "Selected slot was not found."),
    );
  });

  it("throws 409 when the slot is not bookable", async () => {
    const { service } = createFixture([bookableSlot({ bookable: false })]);

    await expect(service.createIntent({ slotId: SLOT_ALICE }, customer)).rejects.toThrow(
      new BookingIntentError(409, "Selected slot is not bookable."),
    );
  });

  it("throws 422 BUNDLE_EXPIRED when the bundle validity deadline has passed", async () => {
    const { service } = createFixture([bookableSlot({ validUntil: NOW_MS - 1 })]);

    const error = await captureError(service.createIntent({ slotId: SLOT_ALICE }, customer));

    expect(error).toBeInstanceOf(BookingIntentError);
    expect((error as BookingIntentError).status).toBe(422);
    expect((error as BookingIntentError).code).toBe(ERROR_CODES.BUNDLE_EXPIRED.code);
    expect((error as Error).message).toMatch(/expired/i);
  });

  it("throws 422 BUNDLE_EXPIRED at the exact deadline instant (inclusive boundary)", async () => {
    const { service } = createFixture([bookableSlot({ validUntil: NOW_MS })]);

    await expect(service.createIntent({ slotId: SLOT_ALICE }, customer)).rejects.toThrow(
      new BookingIntentError(
        422,
        "Bundle for this slot has expired. Redemption is no longer available.",
        ERROR_CODES.BUNDLE_EXPIRED.code,
      ),
    );
  });

  it("throws 422 BUNDLE_NOT_TRANSFERABLE for a non-transferable bundle", async () => {
    const { service } = createFixture([bookableSlot({ transferable: false })]);

    const error = await captureError(service.createIntent({ slotId: SLOT_ALICE }, customer));

    expect(error).toBeInstanceOf(BookingIntentError);
    expect((error as BookingIntentError).status).toBe(422);
    expect((error as BookingIntentError).code).toBe(ERROR_CODES.BUNDLE_NOT_TRANSFERABLE.code);
    expect((error as Error).message).toMatch(/not transferable/i);
  });

  it("lets an admin override a non-transferable bundle", async () => {
    const { service } = createFixture([bookableSlot({ transferable: false })]);

    const intent = await service.createIntent({ slotId: SLOT_ALICE }, admin);

    expect(intent.status).toBe("pending");
  });

  it("throws 403 when the professional tries to book their own slot", async () => {
    const { service } = createFixture();

    await expect(service.createIntent({ slotId: SLOT_ALICE }, alice)).rejects.toThrow(
      new BookingIntentError(403, "You cannot create a booking intent for your own slot."),
    );
  });

  it("throws 409 when the customer already holds an intent for the slot", async () => {
    const { service, intentRepo } = createFixture();
    await seedIntent(intentRepo, { slotId: SLOT_ALICE, customerId: "customer-1" });

    await expect(service.createIntent({ slotId: SLOT_ALICE }, customer)).rejects.toThrow(
      new BookingIntentError(409, "A booking intent already exists for this slot."),
    );
  });

  it("throws 409 when another customer already holds an intent for the slot", async () => {
    const { service, intentRepo } = createFixture();
    await seedIntent(intentRepo, { slotId: SLOT_ALICE, customerId: "customer-9" });

    await expect(service.createIntent({ slotId: SLOT_ALICE }, customer)).rejects.toThrow(
      new BookingIntentError(409, "Selected slot already has an active booking intent."),
    );
  });

  it("throws 500 when the FX provider is unavailable", async () => {
    const { service } = createFixture(
      [bookableSlot({ currency: "USD", amount_minor: 1000 })],
      fxProvider(0, () => {
        throw new Error("stale FX rate");
      }),
    );

    const error = await captureError(
      service.createIntent({ slotId: SLOT_ALICE, buyerCurrency: "EUR" }, customer),
    );

    expect(error).toBeInstanceOf(BookingIntentError);
    expect((error as BookingIntentError).status).toBe(500);
    expect((error as Error).message).toBe("stale FX rate");
  });

  it("validates the slot before it consults the repository", async () => {
    const { service, intentRepo } = createFixture();

    await service.createIntent({ slotId: SLOT_BOB }, customer).catch(() => undefined);

    expect(intentRepo.listAll()).toHaveLength(0);
  });
});

// ─── createIntentTraced ───────────────────────────────────────────────────────

describe("BookingIntentService.createIntentTraced", () => {
  it("creates the intent and reports a successful span", async () => {
    const { service } = createFixture();
    const spans: Span[] = [];
    const exporter = (span: Span): void => {
      spans.push(span);
    };
    addSpanExporter(exporter);

    try {
      const intent = await service.createIntentTraced({ slotId: SLOT_ALICE }, customer);
      expect(intent.status).toBe("pending");
    } finally {
      removeSpanExporter(exporter);
    }

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("bookingIntents.create");
    expect(spans[0].attributes.outcome).toBe("ok");
    expect(spans[0].attributes.route).toBe("POST /api/v1/booking-intents");
  });

  it("propagates the original error and reports a failed span", async () => {
    const { service } = createFixture();
    const spans: Span[] = [];
    const exporter = (span: Span): void => {
      spans.push(span);
    };
    addSpanExporter(exporter);

    try {
      await expect(service.createIntentTraced({ slotId: SLOT_BOB }, customer)).rejects.toThrow(
        new BookingIntentError(404, "Selected slot was not found."),
      );
    } finally {
      removeSpanExporter(exporter);
    }

    expect(spans).toHaveLength(1);
    expect(spans[0].attributes.outcome).toBe("error");
    expect(spans[0].attributes.error).toBe(true);
  });
});

// ─── getIntent / listIntents ──────────────────────────────────────────────────

describe("BookingIntentService reads", () => {
  it("returns the intent to its owner", async () => {
    const { service } = createFixture();
    const created = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    expect(service.getIntent(created.id, customer).id).toBe(created.id);
  });

  it("returns the intent to an admin", async () => {
    const { service } = createFixture();
    const created = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    expect(service.getIntent(created.id, admin).id).toBe(created.id);
  });

  it("hides the intent from another customer behind a 404", async () => {
    const { service } = createFixture();
    const created = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    const error = captureSyncError(() => service.getIntent(created.id, otherCustomer));

    expect(error).toBeInstanceOf(BookingIntentError);
    expect(error?.status).toBe(404);
    expect(error?.message).toBe("Booking intent not found.");
  });

  it("throws 404 for an unknown intent id", () => {
    const { service } = createFixture();

    expect(() => service.getIntent("intent-does-not-exist", customer)).toThrow(
      new BookingIntentError(404, "Booking intent not found."),
    );
  });

  it("scopes listIntents to the customer unless the actor is an admin", async () => {
    const { service } = createFixture([
      bookableSlot(),
      bookableSlot({ id: SLOT_BOB, professional: "bob" }),
    ]);
    await service.createIntent({ slotId: SLOT_ALICE }, customer);
    await service.createIntent({ slotId: SLOT_BOB }, otherCustomer);

    expect(service.listIntents(customer).map((i) => i.customerId)).toEqual(["customer-1"]);
    expect(service.listIntents(otherCustomer).map((i) => i.customerId)).toEqual(["customer-2"]);
    expect(service.listIntents(admin)).toHaveLength(2);
  });
});

// ─── Primary state transitions ────────────────────────────────────────────────

describe("BookingIntentService state transitions", () => {
  const TERMINAL: BookingIntentStatus[] = ["cancelled", "expired", "hold_refunded", "no_show", "firm"];

  async function pricedFixture() {
    const fixture = createFixture([bookableSlot({ pricingStrategy: FIXED_PRICING })]);
    const intent = await fixture.service.createIntent({ slotId: SLOT_ALICE }, customer);
    return { ...fixture, intent };
  }

  describe("confirmIntent", () => {
    it("moves pending → confirmed without releasing the slot", async () => {
      const { service, slotRepo, intent } = await pricedFixture();

      const confirmed = service.confirmIntent(intent.id, customer);

      expect(confirmed.status).toBe("confirmed");
      expect(isBookable(slotRepo, SLOT_ALICE)).toBe(false);
    });

    it("moves hold_placed → confirmed", async () => {
      const { service, intentRepo } = createFixture();
      const hold = await service.createIntent(
        { slotId: SLOT_ALICE, bookingType: "refundable_hold", holdDeadlineMs: HOLD_DEADLINE_MS },
        customer,
      );

      expect(service.confirmIntent(hold.id, customer).status).toBe("confirmed");
      expect(statusOf(intentRepo, hold.id)).toBe("confirmed");
    });

    it("is permitted for an admin who is not the owner", async () => {
      const { service, intent } = await pricedFixture();

      expect(service.confirmIntent(intent.id, admin).status).toBe("confirmed");
    });

    it("throws 403 for a non-owner non-admin", async () => {
      const { service, intent } = await pricedFixture();

      const error = captureSyncError(() => service.confirmIntent(intent.id, otherCustomer));

      expect(error?.status).toBe(403);
      expect(error?.message).toBe(
        "Only the intent owner or admin can confirm a booking intent.",
      );
    });

    it("throws 404 for an unknown intent id", () => {
      const { service } = createFixture();

      expect(() => service.confirmIntent("nope", customer)).toThrow(
        new BookingIntentError(404, "Booking intent not found."),
      );
    });

    it.each(TERMINAL)("throws 409 when confirming an intent already in %s", async (terminal) => {
      const { service, intentRepo } = createFixture();
      const created = await service.createIntent({ slotId: SLOT_ALICE }, customer);
      intentRepo.updateStatus(created.id, terminal);

      const error = captureSyncError(() => service.confirmIntent(created.id, customer));

      expect(error?.status).toBe(409);
      expect(error?.message).toBe(`Cannot confirm intent with status "${terminal}".`);
    });
  });

  describe("cancelIntent", () => {
    it("moves pending → cancelled and releases the slot", async () => {
      const { service, slotRepo, intent } = await pricedFixture();

      const cancelled = service.cancelIntent(intent.id, customer);

      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.refundedAt).toBeUndefined();
      expect(cancelled.refundMetadata).toBeUndefined();
      expect(isBookable(slotRepo, SLOT_ALICE)).toBe(true);
    });

    it("moves hold_placed → hold_refunded and refunds the snapshotted price", async () => {
      const { service, slotRepo, intentRepo } = createFixture([
        bookableSlot({ pricingStrategy: FIXED_PRICING }),
      ]);
      const hold = await service.createIntent(
        { slotId: SLOT_ALICE, bookingType: "refundable_hold", holdDeadlineMs: HOLD_DEADLINE_MS },
        customer,
      );

      const refunded = service.cancelIntent(hold.id, customer);

      expect(refunded.status).toBe("hold_refunded");
      expect(refunded.refundedAt).toBe(NOW_ISO);
      expect(refunded.refundMetadata).toEqual({
        refundedAt: NOW_ISO,
        refundedAmountCents: 1000,
        refundReason: "customer_cancel",
      });
      expect(isBookable(slotRepo, SLOT_ALICE)).toBe(true);
      expect(statusOf(intentRepo, hold.id)).toBe("hold_refunded");
    });

    it("records an admin_reason when an admin cancels a hold", async () => {
      const { service } = createFixture();
      const hold = await service.createIntent(
        { slotId: SLOT_ALICE, bookingType: "refundable_hold", holdDeadlineMs: HOLD_DEADLINE_MS },
        customer,
      );

      const refunded = service.cancelIntent(hold.id, admin);

      expect(refunded.refundMetadata?.refundReason).toBe("admin_action");
    });

    it("refunds 0 for a hold whose slot has no pricing snapshot", async () => {
      const { service } = createFixture();
      const hold = await service.createIntent(
        { slotId: SLOT_ALICE, bookingType: "refundable_hold", holdDeadlineMs: HOLD_DEADLINE_MS },
        customer,
      );

      expect(service.cancelIntent(hold.id, customer).refundMetadata?.refundedAmountCents).toBe(0);
    });

    it("throws 403 for a non-owner non-admin", async () => {
      const { service, intent } = await pricedFixture();

      const error = captureSyncError(() => service.cancelIntent(intent.id, otherCustomer));

      expect(error?.status).toBe(403);
      expect(error?.message).toBe("You are not authorized to cancel this booking intent.");
    });

    it("throws 404 for an unknown intent id", () => {
      const { service } = createFixture();

      expect(() => service.cancelIntent("nope", customer)).toThrow(
        new BookingIntentError(404, "Booking intent not found."),
      );
    });

    it("throws 409 when cancelling a confirmed intent", async () => {
      const { service, intent } = await pricedFixture();
      service.confirmIntent(intent.id, customer);

      const error = captureSyncError(() => service.cancelIntent(intent.id, customer));

      expect(error?.status).toBe(409);
      expect(error?.message).toBe('Cannot cancel intent with status "confirmed".');
    });
  });

  describe("expireIntent", () => {
    it("moves pending → expired and releases the slot", async () => {
      const { service, slotRepo, intentRepo, intent } = await pricedFixture();

      const expired = service.expireIntent(intent.id);

      expect(expired.status).toBe("expired");
      expect(isBookable(slotRepo, SLOT_ALICE)).toBe(true);
      expect(statusOf(intentRepo, intent.id)).toBe("expired");
    });

    it("moves hold_placed → expired", async () => {
      const { service } = createFixture();
      const hold = await service.createIntent(
        { slotId: SLOT_ALICE, bookingType: "refundable_hold", holdDeadlineMs: HOLD_DEADLINE_MS },
        customer,
      );

      expect(service.expireIntent(hold.id).status).toBe("expired");
    });

    it("throws 404 for an unknown intent id", () => {
      const { service } = createFixture();

      expect(() => service.expireIntent("nope")).toThrow(
        new BookingIntentError(404, "Booking intent not found."),
      );
    });

    it.each(["confirmed", "cancelled", "hold_refunded", "no_show"] as BookingIntentStatus[])(
      "throws 409 when expiring an intent already in %s",
      async (terminal) => {
        const { service, intentRepo } = createFixture();
        const created = await service.createIntent({ slotId: SLOT_ALICE }, customer);
        intentRepo.updateStatus(created.id, terminal);

        const error = captureSyncError(() => service.expireIntent(created.id));

        expect(error?.status).toBe(409);
        expect(error?.message).toBe(`Cannot expire intent with status "${terminal}".`);
      },
    );
  });

  describe("refundIntent", () => {
    it("refunds in full when cancelled before the slot starts", async () => {
      const { service, slotRepo, intentRepo, intent } = await pricedFixture();

      const result = service.refundIntent(intent.id, customer, { cancelledAtMs: NOW_MS });

      expect(result.refundAmountCents).toBe(1000);
      expect(result.refundRatio).toBe(1);
      expect(result.consumedRatio).toBe(0);
      expect(result.reason).toBe("partial_refund");
      expect(result.intent.status).toBe("cancelled");
      expect(result.intent.refundedAt).toBe(NOW_ISO);
      expect(result.intent.refundMetadata).toEqual({
        refundedAt: NOW_ISO,
        refundedAmountCents: 1000,
        refundReason: "partial_refund",
      });
      expect(isBookable(slotRepo, SLOT_ALICE)).toBe(true);
      expect(statusOf(intentRepo, intent.id)).toBe("cancelled");
    });

    it("prorates a cancellation issued halfway through the slot", async () => {
      const { service, intent } = await pricedFixture();

      const result = service.refundIntent(intent.id, customer, {
        cancelledAtMs: SLOT_START_MS + HOUR_MS / 2,
      });

      expect(result.consumedRatio).toBe(0.5);
      expect(result.refundRatio).toBe(0.5);
      expect(result.refundAmountCents).toBe(500);
    });

    it("refunds 0 once the slot has fully elapsed", async () => {
      const { service, intent } = await pricedFixture();

      const result = service.refundIntent(intent.id, customer, { cancelledAtMs: SLOT_END_MS });

      expect(result.refundAmountCents).toBe(0);
      expect(result.consumedRatio).toBe(1);
      expect(result.refundRatio).toBe(0);
    });

    it("normalises a blank reason to the partial_refund default", async () => {
      const { service, intent } = await pricedFixture();

      const result = service.refundIntent(intent.id, customer, { reason: "   " });

      expect(result.reason).toBe("partial_refund");
      expect(result.intent.refundMetadata?.refundReason).toBe("partial_refund");
    });

    it("trims a caller-supplied reason", async () => {
      const { service, intent } = await pricedFixture();

      const result = service.refundIntent(intent.id, customer, { reason: "  buyer_request  " });

      expect(result.reason).toBe("buyer_request");
      expect(result.intent.refundMetadata?.refundReason).toBe("buyer_request");
    });

    it("defaults cancelledAtMs to the injected clock", async () => {
      const { service, intent } = await pricedFixture();

      const result = service.refundIntent(intent.id, customer);

      expect(result.refundAmountCents).toBe(1000);
    });

    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
    ])("rejects a %s cancelledAtMs", async (_label, cancelledAtMs) => {
      const { service, intent } = await pricedFixture();

      expect(() => service.refundIntent(intent.id, customer, { cancelledAtMs })).toThrow(
        new BookingIntentError(400, "cancelledAtMs must be a valid number."),
      );
    });

    it("throws 403 for a non-owner non-admin", async () => {
      const { service, intent } = await pricedFixture();

      expect(() => service.refundIntent(intent.id, otherCustomer)).toThrow(
        new BookingIntentError(403, "You are not authorized to refund this booking intent."),
      );
    });

    it("throws 404 for an unknown intent id", () => {
      const { service } = createFixture();

      expect(() => service.refundIntent("nope", customer)).toThrow(
        new BookingIntentError(404, "Booking intent not found."),
      );
    });

    it.each(["cancelled", "expired", "hold_refunded"] as BookingIntentStatus[])(
      "throws 409 when refunding an intent already in %s",
      async (terminal) => {
        const { service, intentRepo } = createFixture();
        const created = await service.createIntent({ slotId: SLOT_ALICE }, customer);
        intentRepo.updateStatus(created.id, terminal);

        const error = captureSyncError(() => service.refundIntent(created.id, customer));

        expect(error?.status).toBe(409);
        expect(error?.message).toBe(`Cannot refund intent with status "${terminal}".`);
      },
    );
  });

  describe("markNoShow", () => {
    async function confirmedIntent() {
      const fixture = createFixture([bookableSlot({ pricingStrategy: FIXED_PRICING })]);
      const intent = await fixture.service.createIntent({ slotId: SLOT_ALICE }, customer);
      fixture.service.confirmIntent(intent.id, customer);
      return { ...fixture, intent };
    }

    it("moves confirmed → no_show, forfeits the default 20% and releases the slot", async () => {
      const { service, slotRepo, intentRepo, intent } = await confirmedIntent();

      const result = await service.markNoShow(intent.id, alice);

      expect(result.status).toBe("no_show");
      expect(result.intent.status).toBe("no_show");
      expect(result.forfeitAmountCents).toBe(200);
      expect(result.reputationDelta).toBe(-1);
      expect(result.reason).toBe("Buyer no-show");
      expect(result.buyerId).toBe("customer-1");
      expect(result.supplierId).toBe("alice");
      expect(isBookable(slotRepo, SLOT_ALICE)).toBe(true);
      expect(statusOf(intentRepo, intent.id)).toBe("no_show");
    });

    it("appends a no_show reputation event for the booking", async () => {
      const { service, intent } = await confirmedIntent();

      await service.markNoShow(intent.id, alice, { forfeitRatio: 0.5 });

      const { events, total } = await listReputationEvents({ supplierId: "customer-1" });
      expect(total).toBe(1);
      expect(events[0]).toMatchObject({
        supplierId: "customer-1",
        actorId: "alice",
        cause: "no_show",
        causeId: intent.id,
        delta: -1,
        scoreBefore: 0,
        scoreAfter: -1,
      });
      expect(events[0].metadata).toMatchObject({
        buyerId: "customer-1",
        supplierId: "alice",
        bookingIntentId: intent.id,
        forfeitRatio: 0.5,
        forfeitAmountCents: 500,
      });
    });

    it("accepts a supplier-requested forfeit ratio of 1 (inclusive upper boundary)", async () => {
      const { service, intent } = await confirmedIntent();

      const result = await service.markNoShow(intent.id, alice, { forfeitRatio: 1 });

      expect(result.forfeitAmountCents).toBe(1000);
    });

    it("trims a caller-supplied reason and falls back to the default when blank", async () => {
      const { service, intent } = await confirmedIntent();

      await expect(
        service.markNoShow(intent.id, alice, { reason: "  customer never arrived  " }),
      ).resolves.toMatchObject({ reason: "customer never arrived" });
    });

    it("falls back to the default reason when only whitespace is supplied", async () => {
      const { service, intent } = await confirmedIntent();

      await expect(service.markNoShow(intent.id, alice, { reason: "   " })).resolves.toMatchObject({
        reason: "Buyer no-show",
      });
    });

    it("allows an admin to mark the no-show", async () => {
      const { service, intent } = await confirmedIntent();

      await expect(service.markNoShow(intent.id, admin)).resolves.toMatchObject({
        status: "no_show",
      });
    });

    it("throws 403 when the buyer tries to mark their own no-show", async () => {
      const { service, intent } = await confirmedIntent();

      const error = await captureError(service.markNoShow(intent.id, customer));

      expect(error).toBeInstanceOf(BookingIntentError);
      expect(error?.status).toBe(403);
      expect(error?.message).toBe("Only the supplier can mark this booking intent as a no-show.");
    });

    it("throws 404 for an unknown intent id", async () => {
      const { service } = createFixture();

      await expect(service.markNoShow("nope", alice)).rejects.toThrow(
        new BookingIntentError(404, "Booking intent not found."),
      );
    });

    it.each([
      ["zero", 0],
      ["a negative ratio", -0.1],
      ["a ratio above 1", 1.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["a numeric string", "0.2" as unknown as number],
    ])("rejects %s as a forfeitRatio", async (_label, forfeitRatio) => {
      const { service, intent } = await confirmedIntent();

      const error = await captureError(service.markNoShow(intent.id, alice, { forfeitRatio }));

      expect(error).toBeInstanceOf(BookingIntentError);
      expect(error?.status).toBe(400);
      expect(error?.message).toBe("forfeitRatio must be a number between 0 and 1.");
    });

    it.each(["cancelled", "expired", "hold_refunded", "no_show"] as BookingIntentStatus[])(
      "throws 409 when marking an intent already in %s",
      async (terminal) => {
        const { service, intentRepo } = createFixture();
        const created = await service.createIntent({ slotId: SLOT_ALICE }, customer);
        intentRepo.updateStatus(created.id, terminal);

        const error = await captureError(service.markNoShow(created.id, alice));

        expect(error).toBeInstanceOf(BookingIntentError);
        expect(error?.status).toBe(409);
        expect(error?.message).toBe(`Cannot mark intent with status "${terminal}" as a no-show.`);
      },
    );
  });

  describe("previewCancel", () => {
    it("applies the ≥7 d tier of the grandfathered policy snapshot", async () => {
      const { service, intent } = await pricedFixture();

      const breakdown = service.previewCancel(intent.id, customer);

      expect(breakdown).toMatchObject({
        fee: 0,
        taxReversal: 100,
        netRefund: 1100,
        policyVersion: "v2-prorated",
        hoursUntilStart: 168,
        basePrice: 1000,
        holdFee: 0,
      });
      expect(breakdown.tierApplied).toEqual({
        minHoursUntilStart: 168,
        maxHoursUntilStart: undefined,
        refundRatio: 1,
      });
    });

    it("does not mutate the intent (preview is read-only)", async () => {
      const { service, intent, intentRepo } = await pricedFixture();

      service.previewCancel(intent.id, customer);

      expect(statusOf(intentRepo, intent.id)).toBe("pending");
    });

    it("throws 403 for a non-owner non-admin", async () => {
      const { service, intent } = await pricedFixture();

      expect(() => service.previewCancel(intent.id, otherCustomer)).toThrow(
        new BookingIntentError(
          403,
          "You are not authorized to preview cancel this booking intent.",
        ),
      );
    });

    it("throws 404 for an unknown intent id", () => {
      const { service } = createFixture();

      expect(() => service.previewCancel("nope", customer)).toThrow(
        new BookingIntentError(404, "Booking intent not found."),
      );
    });

    it("throws 409 for an already-cancelled intent", async () => {
      const { service, intent } = await pricedFixture();
      service.cancelIntent(intent.id, customer);

      const error = captureSyncError(() => service.previewCancel(intent.id, customer));

      expect(error?.status).toBe(409);
      expect(error?.message).toBe("Already cancelled");
    });
  });
});

// ─── autoRefundHold / AutoRefundResult ────────────────────────────────────────

describe("autoRefundHold — AutoRefundResult", () => {
  it("refunds a hold for the snapshotted price and releases the slot", async () => {
    const { service, slotRepo, intentRepo } = createFixture([
      bookableSlot({ pricingStrategy: FIXED_PRICING }),
    ]);
    const hold = await service.createIntent(
      { slotId: SLOT_ALICE, bookingType: "refundable_hold", holdDeadlineMs: HOLD_DEADLINE_MS },
      customer,
    );

    const refunded = service.autoRefundHold(hold.id);

    expect(refunded.status).toBe("hold_refunded");
    expect(refunded.refundedAt).toBe(NOW_ISO);
    expect(refunded.refundMetadata).toEqual({
      refundedAt: NOW_ISO,
      refundedAmountCents: 1000,
      refundReason: "hold_auto_refund",
    });
    expect(isBookable(slotRepo, SLOT_ALICE)).toBe(true);
    expect(statusOf(intentRepo, hold.id)).toBe("hold_refunded");
  });

  it("produces a successful AutoRefundResult for a priced hold", async () => {
    const { service } = createFixture([bookableSlot({ pricingStrategy: FIXED_PRICING })]);
    const hold = await service.createIntent(
      { slotId: SLOT_ALICE, bookingType: "refundable_hold", holdDeadlineMs: HOLD_DEADLINE_MS },
      customer,
    );

    const refunded = service.autoRefundHold(hold.id);
    const result: AutoRefundResult = {
      intentId: refunded.id,
      success: true,
      refundedAmountCents: refunded.refundMetadata?.refundedAmountCents ?? 0,
    };

    expect(result).toEqual({
      intentId: hold.id,
      success: true,
      refundedAmountCents: 1000,
    });
    expect(result.error).toBeUndefined();
  });

  it("produces a successful AutoRefundResult with 0 cents when no price was snapshotted", async () => {
    const { service } = createFixture();
    const hold = await service.createIntent(
      { slotId: SLOT_ALICE, bookingType: "refundable_hold", holdDeadlineMs: HOLD_DEADLINE_MS },
      customer,
    );

    const refunded = service.autoRefundHold(hold.id);
    const result: AutoRefundResult = {
      intentId: refunded.id,
      success: true,
      refundedAmountCents: refunded.refundMetadata?.refundedAmountCents ?? 0,
    };

    expect(result.refundedAmountCents).toBe(0);
  });

  it("produces a failed AutoRefundResult carrying the thrown message", async () => {
    const { service } = createFixture();

    const intentId = "intent-missing";
    const result: AutoRefundResult = (() => {
      try {
        const refunded = service.autoRefundHold(intentId);
        return {
          intentId: refunded.id,
          success: true,
          refundedAmountCents: refunded.refundMetadata?.refundedAmountCents ?? 0,
        };
      } catch (err) {
        return {
          intentId,
          success: false,
          refundedAmountCents: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })();

    expect(result).toEqual({
      intentId: "intent-missing",
      success: false,
      refundedAmountCents: 0,
      error: "Booking intent not found.",
    });
  });

  it("throws 404 for an unknown intent id", () => {
    const { service } = createFixture();

    expect(() => service.autoRefundHold("intent-missing")).toThrow(
      new BookingIntentError(404, "Booking intent not found."),
    );
  });

  it("auto-refunds a standard pending intent as well (no hold required)", async () => {
    const { service } = createFixture();
    const created = await service.createIntent({ slotId: SLOT_ALICE }, customer);

    const refunded = service.autoRefundHold(created.id);

    expect(refunded.status).toBe("hold_refunded");
    expect(refunded.refundMetadata?.refundReason).toBe("hold_auto_refund");
  });
});

// ─── createRecurringIntents(CreateRecurringBookingInput) ──────────────────────

describe("BookingIntentService.createRecurringIntents — CreateRecurringBookingInput", () => {
  it("materializes one pending intent per matching occurrence and reserves the slot", async () => {
    const { service, slotRepo } = createFixture([occurrenceSlot(OCC_1_MS)]);
    const input: CreateRecurringBookingInput = { rrule: RRULE_DAILY_1, note: "weekly session" };

    const report = await service.createRecurringIntents(input, customer);

    expect(report.failures).toEqual([]);
    expect(report.successes).toHaveLength(1);
    const created = report.successes[0];
    expect(created.status).toBe("pending");
    expect(created.bookingType).toBe("standard");
    expect(created.note).toBe("weekly session");
    expect(created.customerId).toBe("customer-1");
    expect(created.slotId).toBe(SLOT_ALICE);
    expect(created.cancellationPolicySnapshot?.policyVersionId).toBe("v2-prorated");
    expect(created.holdFeePolicySnapshot?.supplierId).toBe("alice");
    expect(isBookable(slotRepo, SLOT_ALICE)).toBe(false);
  });

  it("returns a partial report when only some occurrences have inventory", async () => {
    const { service, slotRepo } = createFixture([occurrenceSlot(OCC_1_MS)]);

    const report = await service.createRecurringIntents({ rrule: RRULE_DAILY_2 }, customer);

    expect(report.successes).toHaveLength(1);
    expect(report.failures).toEqual([
      { date: new Date(OCC_2_MS).toISOString(), reason: "No available slot at this time" },
    ]);
    expect(isBookable(slotRepo, SLOT_ALICE)).toBe(false);
  });

  it("reports no failures for a fully-inventoried rule", async () => {
    const { service } = createFixture([
      occurrenceSlot(OCC_1_MS),
      occurrenceSlot(OCC_2_MS, { id: SLOT_BOB, professional: "bob" }),
    ]);

    const report = await service.createRecurringIntents({ rrule: RRULE_DAILY_2 }, customer);

    expect(report.successes).toHaveLength(2);
    expect(report.failures).toEqual([]);
  });

  it("records a failure for a non-transferable bundle without aborting the batch", async () => {
    const { service } = createFixture([
      occurrenceSlot(OCC_1_MS, { transferable: false }),
      occurrenceSlot(OCC_2_MS, { id: SLOT_BOB, professional: "bob" }),
    ]);

    const report = await service.createRecurringIntents({ rrule: RRULE_DAILY_2 }, customer);

    expect(report.successes).toHaveLength(1);
    expect(report.failures[0].reason).toMatch(/not transferable/i);
    expect(report.failures[0].date).toBe(new Date(OCC_1_MS).toISOString());
  });

  it("records a failure when the occurrence is the buyer's own slot", async () => {
    const { service } = createFixture([occurrenceSlot(OCC_1_MS, { professional: "customer-1" })]);

    const report = await service.createRecurringIntents({ rrule: RRULE_DAILY_1 }, customer);

    expect(report.successes).toHaveLength(0);
    expect(report.failures).toEqual([
      { date: new Date(OCC_1_MS).toISOString(), reason: "Cannot book your own slot" },
    ]);
  });

  it("records a failure when the buyer already holds an intent for the occurrence slot", async () => {
    const { service, intentRepo } = createFixture([occurrenceSlot(OCC_1_MS)]);
    await intentRepo.create({
      slotId: SLOT_ALICE,
      professional: "alice",
      customerId: "customer-1",
      startTime: OCC_1_MS,
      endTime: OCC_1_MS + HOUR_MS,
      status: "pending",
      createdAt: NOW_ISO,
    });

    const report = await service.createRecurringIntents({ rrule: RRULE_DAILY_1 }, customer);

    expect(report.successes).toHaveLength(0);
    expect(report.failures[0].reason).toBe("Customer already has an intent for this slot");
  });

  it("records a failure when another customer already holds the occurrence slot", async () => {
    const { service, intentRepo } = createFixture([occurrenceSlot(OCC_1_MS)]);
    await intentRepo.create({
      slotId: SLOT_ALICE,
      professional: "alice",
      customerId: "customer-9",
      startTime: OCC_1_MS,
      endTime: OCC_1_MS + HOUR_MS,
      status: "pending",
      createdAt: NOW_ISO,
    });

    const report = await service.createRecurringIntents({ rrule: RRULE_DAILY_1 }, customer);

    expect(report.successes).toHaveLength(0);
    expect(report.failures[0].reason).toBe("Slot already has active booking intent");
  });

  it("records a failure when the occurrence slot is not bookable", async () => {
    const { service } = createFixture([occurrenceSlot(OCC_1_MS, { bookable: false })]);

    const report = await service.createRecurringIntents({ rrule: RRULE_DAILY_1 }, customer);

    expect(report.successes).toHaveLength(0);
    expect(report.failures[0].reason).toBe("No available slot at this time");
  });

  it.each([
    ["an unbounded rule", "DTSTART:20300318T120000Z\nRRULE:FREQ=DAILY", /Unbounded RRULE/i],
    ["a malformed rule", "DTSTART:20300318T120000Z\nRRULE:NOT-A-RULE", /Invalid RRULE format/i],
    ["an empty rule", "   ", /non-empty string/i],
  ])("rejects %s with 400", async (_label, rrule, matcher) => {
    const { service } = createFixture([occurrenceSlot(OCC_1_MS)]);

    const error = await captureError(service.createRecurringIntents({ rrule }, customer));

    expect(error).toBeInstanceOf(BookingIntentError);
    expect(error?.status).toBe(400);
    expect((error as Error).message).toMatch(matcher);
  });

  it("rejects a DTSTART without an explicit offset with 400", async () => {
    const { service } = createFixture([occurrenceSlot(OCC_1_MS)]);

    const error = await captureError(
      service.createRecurringIntents(
        { rrule: "DTSTART:20300318T120000\nRRULE:FREQ=DAILY;COUNT=1" },
        customer,
      ),
    );

    expect(error).toBeInstanceOf(BookingIntentError);
    expect(error?.status).toBe(400);
    expect((error as Error).message).toMatch(/Ambiguous DTSTART/i);
  });
});
