// @ts-nocheck
import { resolvePricingSnapshot } from "../pricing-snapshot.js";
import {
  resolvePrice,
  DECAY_WINDOW_MS,
} from "../../../services/pricingStrategy.js";
import type { SlotRecord } from "../../slots/slot-repository.js";
import type {
  BookingIntentRecord,
  BookingIntentStatus,
} from "../booking-intent-repository.js";

// ─── Deterministic time fixtures ──────────────────────────────────────────────
// All timestamps are fixed literals — no Date.now() anywhere, so the tests
// are fully deterministic regardless of when they run.

const NOW_MS = 1_900_000_000_000;
const SLOT_START = NOW_MS + DECAY_WINDOW_MS; // exactly 24 h away → full price for time_decay
const SLOT_END = SLOT_START + 3_600_000;

const SLOT_ID = "slot-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SLOT_ID = "slot-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// ─── Hand-built slot fixtures ─────────────────────────────────────────────────

function makeSlot(overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    id: SLOT_ID,
    professional: "alice",
    startTime: SLOT_START,
    endTime: SLOT_END,
    bookable: true,
    ...overrides,
  };
}

/** Fixed strategy with no explicit capacity (must default to 1). */
const FIXED_SLOT = makeSlot({
  pricingStrategy: {
    strategyId: "fixed",
    basePrice: 5000,
    config: { strategy: "fixed" },
  },
});

/** Fixed strategy with an explicit capacity of 5. */
const FIXED_SLOT_WITH_CAPACITY = makeSlot({
  pricingStrategy: {
    strategyId: "fixed",
    basePrice: 5000,
    capacity: 5,
    config: { strategy: "fixed" },
  },
});

/** Demand-based strategy, capacity 4, doubles price when fully booked. */
const DEMAND_SLOT = makeSlot({
  pricingStrategy: {
    strategyId: "demand_based",
    basePrice: 1000,
    capacity: 4,
    config: { strategy: "demand_based", maxMultiplier: 2 },
  },
});

/** Time-decay strategy with the standard 24 h window and 0.5 floor. */
const TIME_DECAY_SLOT = makeSlot({
  pricingStrategy: {
    strategyId: "time_decay",
    basePrice: 1000,
    config: { strategy: "time_decay", windowMs: DECAY_WINDOW_MS, minMultiplier: 0.5 },
  },
});

/** Slot without any pricing strategy attached. */
const NO_STRATEGY_SLOT = makeSlot();

// ─── Hand-built intent fixtures ──────────────────────────────────────────────

function makeIntent(overrides: Partial<BookingIntentRecord> = {}): BookingIntentRecord {
  return {
    id: "intent-1",
    slotId: SLOT_ID,
    professional: "alice",
    customerId: "customer-1",
    startTime: SLOT_START,
    endTime: SLOT_END,
    status: "pending",
    createdAt: new Date(NOW_MS).toISOString(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("resolvePricingSnapshot", () => {
  // ── Missing pricing strategy ───────────────────────────────────────────────

  describe("missing pricing strategy", () => {
    it("returns undefined when the slot has no pricingStrategy", () => {
      const snapshot = resolvePricingSnapshot(NO_STRATEGY_SLOT, [], NOW_MS);
      expect(snapshot).toBeUndefined();
    });

    it("returns undefined even when intents exist", () => {
      const intents = [
        makeIntent({ id: "i-1", status: "pending" }),
        makeIntent({ id: "i-2", status: "confirmed" }),
      ];
      expect(resolvePricingSnapshot(NO_STRATEGY_SLOT, intents, NOW_MS)).toBeUndefined();
    });
  });

  // ── Active-booking counting (status filtering) ─────────────────────────────

  describe("active-booking counting", () => {
    it("counts only pending and confirmed intents for the matching slot", () => {
      const intents: BookingIntentRecord[] = [
        makeIntent({ id: "pending-1", status: "pending" }),
        makeIntent({ id: "confirmed-1", status: "confirmed" }),
        makeIntent({ id: "cancelled-1", status: "cancelled" }),
        makeIntent({ id: "expired-1", status: "expired" }),
        makeIntent({ id: "no-show-1", status: "no_show" }),
        makeIntent({ id: "hold-refunded-1", status: "hold_refunded" }),
        makeIntent({ id: "firm-1", status: "firm" }),
        makeIntent({ id: "escrow-1", status: "escrow_held" }),
        makeIntent({ id: "other-slot-1", slotId: OTHER_SLOT_ID, status: "pending" }),
        makeIntent({ id: "other-slot-2", slotId: OTHER_SLOT_ID, status: "confirmed" }),
      ];

      const snapshot = resolvePricingSnapshot(DEMAND_SLOT, intents, NOW_MS);
      expect(snapshot).toBeDefined();
      // Only the 2 pending/confirmed intents for THIS slot count.
      expect(snapshot!.activeBookings).toBe(2);
    });

    it("cancelled intents do not increment activeBookings", () => {
      const intents: BookingIntentRecord[] = [
        makeIntent({ id: "c-1", status: "cancelled" }),
        makeIntent({ id: "c-2", status: "cancelled" }),
      ];
      const snapshot = resolvePricingSnapshot(DEMAND_SLOT, intents, NOW_MS);
      expect(snapshot!.activeBookings).toBe(0);
    });

    it("expired intents do not increment activeBookings", () => {
      const intents: BookingIntentRecord[] = [
        makeIntent({ id: "e-1", status: "expired" }),
      ];
      const snapshot = resolvePricingSnapshot(DEMAND_SLOT, intents, NOW_MS);
      expect(snapshot!.activeBookings).toBe(0);
    });

    it("intents for a different slot do not increment activeBookings", () => {
      const intents: BookingIntentRecord[] = [
        makeIntent({ id: "o-1", slotId: OTHER_SLOT_ID, status: "pending" }),
        makeIntent({ id: "o-2", slotId: OTHER_SLOT_ID, status: "confirmed" }),
      ];
      const snapshot = resolvePricingSnapshot(DEMAND_SLOT, intents, NOW_MS);
      expect(snapshot!.activeBookings).toBe(0);
    });

    it("uses zero activeBookings when the intent list is empty", () => {
      const snapshot = resolvePricingSnapshot(DEMAND_SLOT, [], NOW_MS);
      expect(snapshot!.activeBookings).toBe(0);
    });
  });

  // ── Capacity default ─────────────────────────────────────────────────────────

  describe("capacity default", () => {
    it("falls back to capacity 1 when the strategy omits capacity", () => {
      const snapshot = resolvePricingSnapshot(FIXED_SLOT, [], NOW_MS);
      expect(snapshot).toBeDefined();
      expect(snapshot!.capacity).toBe(1);
    });

    it("uses the explicit capacity when provided", () => {
      const snapshot = resolvePricingSnapshot(FIXED_SLOT_WITH_CAPACITY, [], NOW_MS);
      expect(snapshot!.capacity).toBe(5);
    });
  });

  // ── Snapshot echoes resolvePrice output ──────────────────────────────────────

  describe("snapshot matches resolvePrice output", () => {
    it("fixed strategy snapshot matches resolvePrice result", () => {
      const intents = [makeIntent({ id: "p-1", status: "pending" })];
      const snapshot = resolvePricingSnapshot(FIXED_SLOT_WITH_CAPACITY, intents, NOW_MS);

      const expected = resolvePrice("fixed", {
        basePrice: 5000,
        slotStartMs: SLOT_START,
        nowMs: NOW_MS,
        activeBookings: 1,
        capacity: 5,
        config: { strategy: "fixed" },
      });

      expect(snapshot).toBeDefined();
      expect(snapshot!.strategyId).toBe(expected.strategyId);
      expect(snapshot!.resolvedPrice).toBe(expected.price);
      expect(snapshot!.basePrice).toBe(expected.snapshot.basePrice);
      expect(snapshot!.slotStartMs).toBe(expected.snapshot.slotStartMs);
      expect(snapshot!.nowMs).toBe(expected.snapshot.nowMs);
      expect(snapshot!.activeBookings).toBe(expected.snapshot.activeBookings);
      expect(snapshot!.capacity).toBe(expected.snapshot.capacity);
      expect(snapshot!.config).toEqual(expected.snapshot.config);
    });

    it("demand_based snapshot matches resolvePrice output with active bookings", () => {
      const intents = [
        makeIntent({ id: "p-1", status: "pending" }),
        makeIntent({ id: "c-1", status: "confirmed" }),
        makeIntent({ id: "x-1", status: "cancelled" }),
      ];
      // 2 active bookings, capacity 4, maxMultiplier 2
      // demandRatio = 2/4 = 0.5 → multiplier = 1 + 0.5 * (2-1) = 1.5
      // price = round(1000 * 1.5) = 1500
      const snapshot = resolvePricingSnapshot(DEMAND_SLOT, intents, NOW_MS);

      const expected = resolvePrice("demand_based", {
        basePrice: 1000,
        slotStartMs: SLOT_START,
        nowMs: NOW_MS,
        activeBookings: 2,
        capacity: 4,
        config: { strategy: "demand_based", maxMultiplier: 2 },
      });

      expect(snapshot).toBeDefined();
      expect(snapshot!.strategyId).toBe(expected.strategyId);
      expect(snapshot!.resolvedPrice).toBe(expected.price);
      expect(snapshot!.resolvedPrice).toBe(1500);
      expect(snapshot!.basePrice).toBe(1000);
      expect(snapshot!.slotStartMs).toBe(SLOT_START);
      expect(snapshot!.nowMs).toBe(NOW_MS);
      expect(snapshot!.activeBookings).toBe(2);
      expect(snapshot!.capacity).toBe(4);
      expect(snapshot!.config).toEqual({ strategy: "demand_based", maxMultiplier: 2 });
    });

    it("time_decay snapshot matches resolvePrice output (full price at window boundary)", () => {
      // Slot is exactly 24 h away → multiplier 1 → full price
      const snapshot = resolvePricingSnapshot(TIME_DECAY_SLOT, [], NOW_MS);

      const expected = resolvePrice("time_decay", {
        basePrice: 1000,
        slotStartMs: SLOT_START,
        nowMs: NOW_MS,
        activeBookings: 0,
        capacity: 1,
        config: { strategy: "time_decay", windowMs: DECAY_WINDOW_MS, minMultiplier: 0.5 },
      });

      expect(snapshot).toBeDefined();
      expect(snapshot!.strategyId).toBe(expected.strategyId);
      expect(snapshot!.resolvedPrice).toBe(expected.price);
      expect(snapshot!.resolvedPrice).toBe(1000); // full price at 24 h boundary
      expect(snapshot!.basePrice).toBe(expected.snapshot.basePrice);
      expect(snapshot!.slotStartMs).toBe(expected.snapshot.slotStartMs);
      expect(snapshot!.nowMs).toBe(expected.snapshot.nowMs);
      expect(snapshot!.activeBookings).toBe(expected.snapshot.activeBookings);
      expect(snapshot!.capacity).toBe(expected.snapshot.capacity);
      expect(snapshot!.config).toEqual(expected.snapshot.config);
    });

    it("snapshot echoes basePrice, slotStartMs, nowMs and config", () => {
      const snapshot = resolvePricingSnapshot(DEMAND_SLOT, [], NOW_MS);
      expect(snapshot).toBeDefined();
      expect(snapshot!.basePrice).toBe(1000);
      expect(snapshot!.slotStartMs).toBe(SLOT_START);
      expect(snapshot!.nowMs).toBe(NOW_MS);
      expect(snapshot!.config).toEqual({ strategy: "demand_based", maxMultiplier: 2 });
    });
  });

  // ── Determinism ─────────────────────────────────────────────────────────────

  describe("determinism", () => {
    it("produces identical snapshots for identical inputs", () => {
      const intents = [
        makeIntent({ id: "p-1", status: "pending" }),
        makeIntent({ id: "c-1", status: "confirmed" }),
      ];
      const a = resolvePricingSnapshot(DEMAND_SLOT, intents, NOW_MS);
      const b = resolvePricingSnapshot(DEMAND_SLOT, intents, NOW_MS);
      expect(a).toEqual(b);
    });

    it("uses the explicit nowMs and never reads Date.now()", () => {
      const explicitNow = 1_700_000_000_000;
      const snapshot = resolvePricingSnapshot(FIXED_SLOT, [], explicitNow);
      expect(snapshot!.nowMs).toBe(explicitNow);
    });
  });
});
