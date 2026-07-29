/**
 * schedulingGraceWindow.test.ts
 * -----------------------------
 * Tests for the grace-window integration in SchedulingService:
 *   - resolveGraceWindow()   — per-slot category lookup with fallback
 *   - noShowDeadlineMs()     — deadline = startTime + graceWindowMs
 */

import {
  SchedulingService,
  SlotNotFoundError,
} from "../services/schedulingService.js";
import {
  GraceWindowService,
  InMemoryGraceWindowStore,
  DEFAULT_GRACE_WINDOW_SECONDS,
} from "../services/graceWindowService.js";
import {
  InMemorySlotRepository,
  type SlotRecord,
} from "../modules/slots/slot-repository.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSlot(overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    id: "slot-00000000-0000-4000-8000-000000000001",
    professional: "alice",
    startTime: 1_900_000_000_000,
    endTime:   1_900_000_360_000,
    bookable: true,
    ...overrides,
  };
}

function makeGraceWindowService(
  configs: Array<{ category: string; graceWindowSeconds: number }> = [],
): GraceWindowService {
  const store = new InMemoryGraceWindowStore();
  const svc = new GraceWindowService({
    store,
    nowIso: () => "2026-07-28T12:00:00.000Z",
    auditLogger: { log: async () => {} } as any,
  });

  // Pre-seed configs synchronously via the store directly (bypass async).
  for (const { category, graceWindowSeconds } of configs) {
    store.set({ category, graceWindowSeconds, updatedBy: "seed", updatedAt: "" });
  }

  return svc;
}

function makeScheduler(
  slots: SlotRecord[],
  graceWindowConfigs: Array<{ category: string; graceWindowSeconds: number }> = [],
): SchedulingService {
  const slotRepo = new InMemorySlotRepository(slots);
  const intentRepo = new InMemoryBookingIntentRepository();
  const gwSvc = makeGraceWindowService(graceWindowConfigs);
  return new SchedulingService(slotRepo, intentRepo, gwSvc);
}

// ─── resolveGraceWindow() ─────────────────────────────────────────────────────

describe("SchedulingService.resolveGraceWindow()", () => {
  it("returns DEFAULT when slot has no category", () => {
    const scheduler = makeScheduler([makeSlot()]);
    expect(scheduler.resolveGraceWindow("slot-00000000-0000-4000-8000-000000000001"))
      .toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("returns DEFAULT when slot has a category with no configured override", () => {
    const scheduler = makeScheduler([makeSlot({ category: "fitness" })]);
    expect(scheduler.resolveGraceWindow("slot-00000000-0000-4000-8000-000000000001"))
      .toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("returns category-specific value when override is configured", () => {
    const scheduler = makeScheduler(
      [makeSlot({ category: "medical" })],
      [{ category: "medical", graceWindowSeconds: 600 }],
    );
    expect(scheduler.resolveGraceWindow("slot-00000000-0000-4000-8000-000000000001"))
      .toBe(600);
  });

  it("returns DEFAULT for an unknown category", () => {
    const scheduler = makeScheduler(
      [makeSlot({ category: "exotic-category" })],
      [{ category: "medical", graceWindowSeconds: 600 }],
    );
    expect(scheduler.resolveGraceWindow("slot-00000000-0000-4000-8000-000000000001"))
      .toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("throws SlotNotFoundError for non-existent slot", () => {
    const scheduler = makeScheduler([]);
    expect(() => scheduler.resolveGraceWindow("slot-00000000-0000-4000-8000-000000000099"))
      .toThrow(SlotNotFoundError);
  });

  it("different categories resolve independently", () => {
    const slots = [
      makeSlot({ id: "slot-00000000-0000-4000-8000-000000000001", category: "medical" }),
      makeSlot({ id: "slot-00000000-0000-4000-8000-000000000002", category: "fitness", startTime: 2_000_000_000_000, endTime: 2_000_000_360_000 }),
    ];
    const scheduler = makeScheduler(slots, [
      { category: "medical", graceWindowSeconds: 600 },
      { category: "fitness", graceWindowSeconds: 120 },
    ]);
    expect(scheduler.resolveGraceWindow("slot-00000000-0000-4000-8000-000000000001")).toBe(600);
    expect(scheduler.resolveGraceWindow("slot-00000000-0000-4000-8000-000000000002")).toBe(120);
  });
});

// ─── noShowDeadlineMs() ───────────────────────────────────────────────────────

describe("SchedulingService.noShowDeadlineMs()", () => {
  const START_TIME = 1_900_000_000_000;

  it("returns startTime + defaultGraceWindow * 1000 when no category config", () => {
    const scheduler = makeScheduler([makeSlot({ startTime: START_TIME })]);
    const expected = START_TIME + DEFAULT_GRACE_WINDOW_SECONDS * 1000;
    expect(scheduler.noShowDeadlineMs("slot-00000000-0000-4000-8000-000000000001"))
      .toBe(expected);
  });

  it("uses category-specific grace window", () => {
    const GRACE_S = 300;
    const scheduler = makeScheduler(
      [makeSlot({ startTime: START_TIME, category: "beauty" })],
      [{ category: "beauty", graceWindowSeconds: GRACE_S }],
    );
    const expected = START_TIME + GRACE_S * 1000;
    expect(scheduler.noShowDeadlineMs("slot-00000000-0000-4000-8000-000000000001"))
      .toBe(expected);
  });

  it("throws SlotNotFoundError for non-existent slot", () => {
    const scheduler = makeScheduler([]);
    expect(() => scheduler.noShowDeadlineMs("slot-00000000-0000-4000-8000-000000000099"))
      .toThrow(SlotNotFoundError);
  });

  it("deadline is strictly after startTime", () => {
    const scheduler = makeScheduler([makeSlot({ startTime: START_TIME })]);
    const deadline = scheduler.noShowDeadlineMs("slot-00000000-0000-4000-8000-000000000001");
    expect(deadline).toBeGreaterThan(START_TIME);
  });

  it("deadline equals startTime + 1s for minimum grace window of 1s", () => {
    const scheduler = makeScheduler(
      [makeSlot({ startTime: START_TIME, category: "express" })],
      [{ category: "express", graceWindowSeconds: 1 }],
    );
    expect(scheduler.noShowDeadlineMs("slot-00000000-0000-4000-8000-000000000001"))
      .toBe(START_TIME + 1000);
  });

  it("deadline equals startTime + 86400s for maximum grace window", () => {
    const scheduler = makeScheduler(
      [makeSlot({ startTime: START_TIME, category: "all-day" })],
      [{ category: "all-day", graceWindowSeconds: 86_400 }],
    );
    expect(scheduler.noShowDeadlineMs("slot-00000000-0000-4000-8000-000000000001"))
      .toBe(START_TIME + 86_400_000);
  });
});

// ─── Grace-window injection ───────────────────────────────────────────────────

describe("SchedulingService grace-window injection", () => {
  it("uses injected GraceWindowService rather than singleton", () => {
    const customGwSvc = makeGraceWindowService([
      { category: "vip", graceWindowSeconds: 7200 },
    ]);
    const slotRepo = new InMemorySlotRepository([
      makeSlot({ category: "vip" }),
    ]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const scheduler = new SchedulingService(slotRepo, intentRepo, customGwSvc);
    expect(scheduler.resolveGraceWindow("slot-00000000-0000-4000-8000-000000000001"))
      .toBe(7200);
  });

  it("falls back to singleton when no service injected", () => {
    // The singleton has no configs, so default is expected.
    const slotRepo = new InMemorySlotRepository([makeSlot()]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const scheduler = new SchedulingService(slotRepo, intentRepo);
    expect(scheduler.resolveGraceWindow("slot-00000000-0000-4000-8000-000000000001"))
      .toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });
});
