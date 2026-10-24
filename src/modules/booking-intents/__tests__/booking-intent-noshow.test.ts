/**
 * Regression + acceptance suite for the no-show path.
 *
 * Covers:
 *   #1300 — a no-show is only allowed on a confirmed intent whose
 *           `startTime + graceMs` has passed.
 *   #1322 — a no-show issues a buyer strike through `StrikeService` instead
 *           of writing a supplier reputation event keyed by the buyer, and a
 *           strike failure leaves the intent untouched.
 *
 * The service clock is injected (`nowMs`), so every grace-window boundary is
 * deterministic and no wall-clock / network / database dependency is used.
 */

import { jest } from "@jest/globals";
import {
  BookingIntentError,
  BookingIntentService,
  DEFAULT_NO_SHOW_GRACE_MS,
  type NoShowStrikeService,
} from "../booking-intent-service.js";
import {
  InMemoryBookingIntentRepository,
  type BookingIntentStatus,
} from "../booking-intent-repository.js";
import {
  InMemorySlotRepository,
  type SlotPricingStrategy,
  type SlotRecord,
} from "../../slots/slot-repository.js";
import { GraceWindowService } from "../../../services/graceWindowService.js";
import { StrikeService } from "../../../services/strikeService.js";
import {
  _resetReputationEventStore,
  listReputationEvents,
} from "../../../services/reputationWriteAudit.js";
import type { AuthContext } from "../../../middleware/auth.js";
import type { VerifiedJwtPayload } from "../../../utils/jwt.js";

const NOW_MS = 1_900_000_000_000; // 2030-03-17T17:46:40.000Z
const NOW_ISO = new Date(NOW_MS).toISOString();
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const SLOT_ID = "slot-11111111-1111-4111-8111-111111111111";
const BUYER_ID = "customer-1";
const SUPPLIER_ID = "alice";

const CLAIMS = {} as VerifiedJwtPayload;
const supplier: AuthContext = { userId: SUPPLIER_ID, role: "professional", claims: CLAIMS };
const customer: AuthContext = { userId: BUYER_ID, role: "customer", claims: CLAIMS };

const FIXED_PRICING: SlotPricingStrategy = {
  strategyId: "fixed",
  basePrice: 1000,
  capacity: 1,
  config: { strategy: "fixed" },
};

type StrikeCall = Parameters<NoShowStrikeService["issueStrike"]>[0];
type StrikeResult = Awaited<ReturnType<NoShowStrikeService["issueStrike"]>>;

/** Recording fake; the default implementation always succeeds. */
function fakeStrikeService(
  impl: (params: StrikeCall) => Promise<StrikeResult> = async () => ({
    strike: { id: "strike-fake-1" },
    autoSuspended: false,
  }),
): { service: NoShowStrikeService; calls: StrikeCall[] } {
  const calls: StrikeCall[] = [];
  return {
    calls,
    service: {
      issueStrike: async (params) => {
        calls.push(params);
        return impl(params);
      },
    },
  };
}

function slotStartingAt(startTime: number, category?: string): SlotRecord {
  return {
    id: SLOT_ID,
    professional: SUPPLIER_ID,
    startTime,
    endTime: startTime + HOUR_MS,
    bookable: true,
    pricingStrategy: FIXED_PRICING,
    category,
  };
}

async function createFixture(options: {
  startTimeMs: number;
  status?: BookingIntentStatus;
  strike: NoShowStrikeService;
  graceMs?: number;
  graceWindowService?: Pick<GraceWindowService, "resolve">;
  category?: string;
}) {
  const slotRepo = new InMemorySlotRepository([slotStartingAt(options.startTimeMs, options.category)]);
  const intentRepo = new InMemoryBookingIntentRepository();
  const service = new BookingIntentService(
    intentRepo,
    slotRepo,
    () => NOW_ISO,
    () => NOW_MS,
    undefined,
    undefined,
    undefined,
    {
      strikeService: options.strike,
      noShowGraceMs: options.graceMs,
      graceWindowService: options.graceWindowService,
    },
  );

  const intent = await service.createIntent({ slotId: SLOT_ID }, customer);
  service.confirmIntent(intent.id, customer);
  if (options.status && options.status !== "confirmed") {
    intentRepo.updateStatus(intent.id, options.status);
  }

  return { slotRepo, intentRepo, service, intent };
}

async function captureError(promise: Promise<unknown>): Promise<BookingIntentError | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err as BookingIntentError;
  }
}

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW_MS);
  _resetReputationEventStore();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── #1300 — no-show time gate ───────────────────────────────────────────────

describe("markNoShow time gate (#1300)", () => {
  const GRACE_MS = 15 * MINUTE_MS;

  it("rejects a no-show before the slot starts (regression: succeeds on main)", async () => {
    const strike = fakeStrikeService();
    const { service, intentRepo, intent } = await createFixture({
      startTimeMs: NOW_MS + 2 * HOUR_MS,
      strike: strike.service,
      graceMs: GRACE_MS,
    });

    const error = await captureError(service.markNoShow(intent.id, supplier));

    expect(error).toBeInstanceOf(BookingIntentError);
    expect(error?.status).toBe(409);
    expect(error?.message).toMatch(/before the booked slot has started/);
    expect(intentRepo.findById(intent.id)?.status).toBe("confirmed");
    expect(strike.calls).toHaveLength(0);
  });

  it("rejects a no-show inside the grace window", async () => {
    const strike = fakeStrikeService();
    const { service, intentRepo, intent } = await createFixture({
      startTimeMs: NOW_MS - 5 * MINUTE_MS,
      strike: strike.service,
      graceMs: GRACE_MS,
    });

    const error = await captureError(service.markNoShow(intent.id, supplier));

    expect(error?.status).toBe(409);
    expect(error?.message).toContain(`${GRACE_MS}ms grace`);
    expect(intentRepo.findById(intent.id)?.status).toBe("confirmed");
    expect(strike.calls).toHaveLength(0);
  });

  it("rejects a no-show one millisecond before start + grace", async () => {
    const strike = fakeStrikeService();
    const { service, intent } = await createFixture({
      startTimeMs: NOW_MS - GRACE_MS + 1,
      strike: strike.service,
      graceMs: GRACE_MS,
    });

    const error = await captureError(service.markNoShow(intent.id, supplier));

    expect(error?.status).toBe(409);
    expect(strike.calls).toHaveLength(0);
  });

  it("allows a no-show exactly at start + grace", async () => {
    const strike = fakeStrikeService();
    const { service, intent } = await createFixture({
      startTimeMs: NOW_MS - GRACE_MS,
      strike: strike.service,
      graceMs: GRACE_MS,
    });

    const result = await service.markNoShow(intent.id, supplier);

    expect(result.status).toBe("no_show");
    expect(strike.calls).toHaveLength(1);
  });

  it("allows a no-show after the grace window and keeps the response shape", async () => {
    const strike = fakeStrikeService();
    const { service, slotRepo, intentRepo, intent } = await createFixture({
      startTimeMs: NOW_MS - 2 * HOUR_MS,
      strike: strike.service,
      graceMs: GRACE_MS,
    });

    const result = await service.markNoShow(intent.id, supplier);

    expect(result).toMatchObject({
      status: "no_show",
      buyerId: BUYER_ID,
      supplierId: SUPPLIER_ID,
      forfeitAmountCents: 200,
      strikeId: "strike-fake-1",
      autoSuspended: false,
      reason: "Buyer no-show",
    });
    expect(result.intent.status).toBe("no_show");
    expect(intentRepo.findById(intent.id)?.status).toBe("no_show");
    expect(slotRepo.findById(SLOT_ID)?.bookable).toBe(true);
  });

  it.each(["pending", "hold_placed"] as BookingIntentStatus[])(
    "rejects a %s intent even after the grace window",
    async (status) => {
      const strike = fakeStrikeService();
      const { service, intentRepo, intent } = await createFixture({
        startTimeMs: NOW_MS - 2 * HOUR_MS,
        status,
        strike: strike.service,
        graceMs: GRACE_MS,
      });

      const error = await captureError(service.markNoShow(intent.id, supplier));

      expect(error).toBeInstanceOf(BookingIntentError);
      expect(error?.status).toBe(409);
      expect(error?.message).toBe(`Cannot mark intent with status "${status}" as a no-show.`);
      expect(intentRepo.findById(intent.id)?.status).toBe(status);
      expect(strike.calls).toHaveLength(0);
    },
  );

  it("defaults to the platform-wide 15-minute grace window", async () => {
    const strike = fakeStrikeService();

    const inside = await createFixture({
      startTimeMs: NOW_MS - 10 * MINUTE_MS,
      strike: strike.service,
      graceWindowService: new GraceWindowService(),
    });
    expect((await captureError(inside.service.markNoShow(inside.intent.id, supplier)))?.status).toBe(
      409,
    );

    const outside = await createFixture({
      startTimeMs: NOW_MS - 20 * MINUTE_MS,
      strike: strike.service,
      graceWindowService: new GraceWindowService(),
    });
    await expect(outside.service.markNoShow(outside.intent.id, supplier)).resolves.toMatchObject({
      status: "no_show",
    });
    expect(DEFAULT_NO_SHOW_GRACE_MS).toBe(15 * MINUTE_MS);
  });

  it("honours the admin-configured per-slot-category grace window", async () => {
    const graceWindows = new GraceWindowService();
    await graceWindows.set({
      category: "medical",
      graceWindowSeconds: 20 * 60,
      changedBy: "admin-1",
    });
    const strike = fakeStrikeService();

    const inside = await createFixture({
      startTimeMs: NOW_MS - 19 * MINUTE_MS,
      category: "medical",
      strike: strike.service,
      graceWindowService: graceWindows,
    });
    expect((await captureError(inside.service.markNoShow(inside.intent.id, supplier)))?.status).toBe(
      409,
    );

    const outside = await createFixture({
      startTimeMs: NOW_MS - 21 * MINUTE_MS,
      category: "medical",
      strike: strike.service,
      graceWindowService: graceWindows,
    });
    await expect(outside.service.markNoShow(outside.intent.id, supplier)).resolves.toMatchObject({
      status: "no_show",
    });
  });
});

// ─── #1322 — buyer strike instead of supplier reputation write ──────────────

describe("markNoShow buyer strike (#1322)", () => {
  it("issues exactly one strike for the buyer and no supplier reputation event", async () => {
    const strike = fakeStrikeService();
    const { service, intent } = await createFixture({
      startTimeMs: NOW_MS - 2 * HOUR_MS,
      strike: strike.service,
    });

    const result = await service.markNoShow(intent.id, supplier, { reason: "did not arrive" });

    expect(strike.calls).toEqual([
      {
        buyerId: BUYER_ID,
        intentId: intent.id,
        slotId: SLOT_ID,
        reason: "did not arrive",
        issuedAt: NOW_MS,
      },
    ]);
    expect(result.strikeId).toBe("strike-fake-1");

    // Regression (#1322): the old implementation wrote a supplier reputation
    // event with `supplierId: customerId`; nothing may be written now.
    expect((await listReputationEvents({ supplierId: BUYER_ID })).total).toBe(0);
    expect((await listReputationEvents({ supplierId: SUPPLIER_ID })).total).toBe(0);
  });

  it("returns strikeId/autoSuspended and drops the fake reputationDelta", async () => {
    const strike = fakeStrikeService();
    const { service, intent } = await createFixture({
      startTimeMs: NOW_MS - 2 * HOUR_MS,
      strike: strike.service,
    });

    const result = await service.markNoShow(intent.id, supplier);

    expect(result).not.toHaveProperty("reputationDelta");
    expect(result.strikeId).toBe("strike-fake-1");
    expect(result.autoSuspended).toBe(false);
  });

  it("reports autoSuspended when the third strike trips StrikeConfig", async () => {
    const strikes = new StrikeService();
    await strikes.issueStrike({ buyerId: BUYER_ID, issuedAt: NOW_MS - 2_000 });
    await strikes.issueStrike({ buyerId: BUYER_ID, issuedAt: NOW_MS - 1_000 });

    const { service, intent } = await createFixture({
      startTimeMs: NOW_MS - 2 * HOUR_MS,
      strike: strikes,
    });

    const result = await service.markNoShow(intent.id, supplier);

    expect(result.autoSuspended).toBe(true);
    expect(strikes.getActiveStrikes(BUYER_ID, NOW_MS)).toHaveLength(3);
    expect(strikes.getStrike(result.strikeId)?.buyerId).toBe(BUYER_ID);
    expect(strikes.getBuyerSuspensionStatus(BUYER_ID, NOW_MS).isSuspended).toBe(true);
  });

  it("leaves the intent and slot unchanged when the strike service throws", async () => {
    const strike = fakeStrikeService(async () => {
      throw new Error("strike audit unavailable");
    });
    const { service, slotRepo, intentRepo, intent } = await createFixture({
      startTimeMs: NOW_MS - 2 * HOUR_MS,
      strike: strike.service,
    });

    expect(slotRepo.findById(SLOT_ID)?.bookable).toBe(false);

    await expect(service.markNoShow(intent.id, supplier)).rejects.toThrow(
      "strike audit unavailable",
    );

    expect(intentRepo.findById(intent.id)?.status).toBe("confirmed");
    expect(slotRepo.findById(SLOT_ID)?.bookable).toBe(false);
  });
});
