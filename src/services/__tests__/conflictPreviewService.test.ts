/**
 * Tests for ConflictPreviewService
 *
 * Covers:
 *  - No conflicts (clean series)
 *  - Single and multiple overlap conflicts
 *  - Full containment (proposed inside existing)
 *  - Adjacent slots (no conflict — half-open interval)
 *  - Different professionals (no conflict)
 *  - TZ-ambiguity detection (DST transition)
 *  - Blackout category (reserved, never triggered)
 *  - Empty series / no occurrences in horizon
 *  - Horizon boundary exclusion
 *  - Invalid RRULE rejection
 *  - suggestedNextSafeStart correctness
 *  - findNextSafeStart with no gap available
 *  - categorizeConflict edge cases
 *  - Custom horizonDays
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  ConflictPreviewService,
  DEFAULT_HORIZON_DAYS,
} from "../conflictPreviewService.js";
import type { SlotRepository, SlotRecord } from "../../modules/slots/slot-repository.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Round a millisecond timestamp UP to the next whole second boundary.
 * The rrule library truncates to second precision when parsing DTSTART,
 * so we align test timestamps to avoid sub-second drift.
 */
function alignToSecond(ms: number): number {
  return Math.ceil(ms / 1000) * 1000;
}

function makeSlot(overrides: Partial<SlotRecord> & { id: string; professional: string; startTime: number; endTime: number }): SlotRecord {
  return { bookable: true, ...overrides };
}

function buildMockRepo(slots: SlotRecord[]): SlotRepository {
  return {
    list: () => slots.map((s) => ({ ...s })),
    findById: (id: string) => slots.find((s) => s.id === id) ? { ...slots.find((s) => s.id === id)! } : undefined,
    hasConflict: () => false,
    updateBookable: () => {},
  };
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${day}T${h}${min}${s}Z`;
}

function dailyRRule(startMs: number, count: number): string {
  return `DTSTART:${fmtDate(startMs)}\nRRULE:FREQ=DAILY;COUNT=${count}`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ConflictPreviewService", () => {
  let now: number;
  let realDateNow: typeof Date.now;

  beforeEach(() => {
    realDateNow = Date.now;
    now = alignToSecond(Date.now());
    Date.now = jest.fn(() => now) as any;
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  // ── No conflicts ─────────────────────────────────────────────────────────

  describe("no conflicts", () => {
    it("returns empty conflicts when no slots exist", async () => {
      const repo = buildMockRepo([]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(now + DAY_MS, 3),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflictsFound).toBe(0);
      expect(result.conflicts).toEqual([]);
      expect(result.totalOccurrences).toBe(3);
    });

    it("returns empty conflicts when slots belong to a different professional", async () => {
      const slot = makeSlot({
        id: "slot-1",
        professional: "bob",
        startTime: now + DAY_MS,
        endTime: now + DAY_MS + HOUR_MS,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(now + DAY_MS, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflictsFound).toBe(0);
    });
  });

  // ── Single overlap ───────────────────────────────────────────────────────

  describe("single overlap", () => {
    it("detects a single overlap conflict", async () => {
      const occStart = now + DAY_MS;
      const slot = makeSlot({
        id: "slot-abc",
        professional: "alice",
        startTime: occStart + 1_000,
        endTime: occStart + HOUR_MS,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occStart, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflictsFound).toBe(1);
      expect(result.conflicts[0].reason).toBe("overlap");
      expect(result.conflicts[0].conflict.slotId).toBe("slot-abc");
      expect(result.conflicts[0].proposedStart).toBe(occStart);
      expect(result.conflicts[0].proposedEnd).toBe(occStart + HOUR_MS);
    });
  });

  // ── Multiple overlaps ────────────────────────────────────────────────────

  describe("multiple overlaps", () => {
    it("detects conflicts across multiple occurrences", async () => {
      const occ1Start = now + DAY_MS;
      const occ2Start = now + 2 * DAY_MS;
      const slot1 = makeSlot({
        id: "slot-1",
        professional: "alice",
        startTime: occ1Start,
        endTime: occ1Start + HOUR_MS,
      });
      const slot2 = makeSlot({
        id: "slot-2",
        professional: "alice",
        startTime: occ2Start,
        endTime: occ2Start + HOUR_MS,
      });
      const repo = buildMockRepo([slot1, slot2]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occ1Start, 2),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflictsFound).toBe(2);
      expect(result.conflicts.map((c) => c.conflict.slotId)).toEqual(
        expect.arrayContaining(["slot-1", "slot-2"]),
      );
    });

    it("detects multiple conflicts for a single occurrence", async () => {
      const occStart = now + DAY_MS;
      const slot1 = makeSlot({
        id: "slot-a",
        professional: "alice",
        startTime: occStart,
        endTime: occStart + HOUR_MS / 2,
      });
      const slot2 = makeSlot({
        id: "slot-b",
        professional: "alice",
        startTime: occStart + HOUR_MS / 4,
        endTime: occStart + HOUR_MS,
      });
      const repo = buildMockRepo([slot1, slot2]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occStart, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflictsFound).toBe(2);
      expect(result.conflicts[0].conflict.slotId).toBe("slot-a");
      expect(result.conflicts[1].conflict.slotId).toBe("slot-b");
    });
  });

  // ── Full containment ─────────────────────────────────────────────────────

  describe("full containment", () => {
    it("detects when proposed slot fully contains an existing slot", async () => {
      const occStart = now + DAY_MS;
      const slot = makeSlot({
        id: "slot-inner",
        professional: "alice",
        startTime: occStart + 1_000,
        endTime: occStart + HOUR_MS - 1_000,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occStart, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflictsFound).toBe(1);
      expect(result.conflicts[0].reason).toBe("overlap");
    });
  });

  // ── Adjacent slots ───────────────────────────────────────────────────────

  describe("adjacent slots", () => {
    it("does not treat adjacent slots as conflicts (half-open interval)", async () => {
      const occStart = now + DAY_MS;
      const slot = makeSlot({
        id: "slot-adjacent",
        professional: "alice",
        startTime: occStart - HOUR_MS,
        endTime: occStart,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occStart, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflictsFound).toBe(0);
    });

    it("does not treat proposed ending at existing start as conflict", async () => {
      const occStart = now + DAY_MS;
      const slot = makeSlot({
        id: "slot-after",
        professional: "alice",
        startTime: occStart + HOUR_MS,
        endTime: occStart + 2 * HOUR_MS,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occStart, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflictsFound).toBe(0);
    });
  });

  // ── Horizon boundary ─────────────────────────────────────────────────────

  describe("horizon boundary", () => {
    it("excludes occurrences beyond the horizon", async () => {
      const horizonEnd = now + DEFAULT_HORIZON_DAYS * DAY_MS;
      const outsideHorizon = horizonEnd + DAY_MS;

      const slot = makeSlot({
        id: "slot-outside",
        professional: "alice",
        startTime: outsideHorizon,
        endTime: outsideHorizon + HOUR_MS,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(now + DAY_MS, 2),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflictsFound).toBe(0);
    });

    it("uses custom horizonDays when provided", async () => {
      const customHorizon = 7;
      const occStart = now + 5 * DAY_MS;
      const slot = makeSlot({
        id: "slot-custom",
        professional: "alice",
        startTime: occStart,
        endTime: occStart + HOUR_MS,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occStart, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
        horizonDays: customHorizon,
      });

      expect(result.horizonDays).toBe(customHorizon);
      expect(result.conflictsFound).toBe(1);
    });
  });

  // ── Invalid RRULE ────────────────────────────────────────────────────────

  describe("invalid RRULE", () => {
    it("throws RecurrenceError for empty rrule", async () => {
      const service = new ConflictPreviewService(buildMockRepo([]));

      await expect(
        service.previewConflicts({
          rrule: "",
          professional: "alice",
          slotDurationMs: HOUR_MS,
        }),
      ).rejects.toThrow("rrule must be a non-empty string");
    });

    it("throws RecurrenceError for unbounded RRULE", async () => {
      const service = new ConflictPreviewService(buildMockRepo([]));

      await expect(
        service.previewConflicts({
          rrule: "FREQ=WEEKLY;BYDAY=MO",
          professional: "alice",
          slotDurationMs: HOUR_MS,
        }),
      ).rejects.toThrow("Unbounded RRULE");
    });

    it("throws RecurrenceError for invalid RRULE format", async () => {
      const service = new ConflictPreviewService(buildMockRepo([]));

      await expect(
        service.previewConflicts({
          rrule: "NOT_AN_RRULE",
          professional: "alice",
          slotDurationMs: HOUR_MS,
        }),
      ).rejects.toThrow("Invalid RRULE format");
    });
  });

  // ── suggestedNextSafeStart ───────────────────────────────────────────────

  describe("suggestedNextSafeStart", () => {
    it("suggests the end of the conflicting slot when no further conflicts", async () => {
      const occStart = now + DAY_MS;
      const slotEnd = occStart + HOUR_MS;
      const slot = makeSlot({
        id: "slot-suggest",
        professional: "alice",
        startTime: occStart,
        endTime: slotEnd,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occStart, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflicts[0].suggestedNextSafeStart).toBe(slotEnd);
    });

    it("suggests the end of the last conflicting slot when chain of conflicts", async () => {
      const occStart = now + DAY_MS;
      const slot1 = makeSlot({
        id: "slot-chain-1",
        professional: "alice",
        startTime: occStart,
        endTime: occStart + HOUR_MS,
      });
      const slot2 = makeSlot({
        id: "slot-chain-2",
        professional: "alice",
        startTime: occStart + HOUR_MS,
        endTime: occStart + 2 * HOUR_MS,
      });
      const repo = buildMockRepo([slot1, slot2]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occStart, 1),
        professional: "alice",
        slotDurationMs: 3 * HOUR_MS,
      });

      expect(result.conflicts[0].suggestedNextSafeStart).toBe(occStart + 2 * HOUR_MS);
    });

    it("returns undefined when no gap exists within search window", async () => {
      const occStart = now + DAY_MS;
      const manySlots: SlotRecord[] = [];
      for (let i = 0; i < 101; i++) {
        manySlots.push(
          makeSlot({
            id: `slot-packed-${i}`,
            professional: "alice",
            startTime: occStart + i * HOUR_MS,
            endTime: occStart + (i + 1) * HOUR_MS,
          }),
        );
      }
      const repo = buildMockRepo(manySlots);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occStart, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflicts[0].suggestedNextSafeStart).toBeUndefined();
    });
  });

  // ── categorizeConflict ───────────────────────────────────────────────────

  describe("categorizeConflict", () => {
    it("returns 'overlap' when no timezone is provided", () => {
      const service = new ConflictPreviewService(buildMockRepo([]));
      const result = service.categorizeConflict(now, now + HOUR_MS, now, now + HOUR_MS);
      expect(result).toBe("overlap");
    });

    it("returns 'overlap' when timezone is provided but not in DST transition", () => {
      const service = new ConflictPreviewService(buildMockRepo([]));
      const winterDate = new Date("2026-01-15T12:00:00Z").getTime();
      const result = service.categorizeConflict(winterDate, winterDate + HOUR_MS, winterDate, winterDate + HOUR_MS, "America/New_York");
      expect(result).toBe("overlap");
    });

    it("returns 'tz-ambiguity' during DST transition", () => {
      const service = new ConflictPreviewService(buildMockRepo([]));
      const dstDate = new Date("2026-03-08T07:00:00Z").getTime();
      const result = service.categorizeConflict(dstDate, dstDate + HOUR_MS, dstDate, dstDate + HOUR_MS, "America/New_York");
      expect(result).toBe("tz-ambiguity");
    });
  });

  // ── findNextSafeStart (standalone) ──────────────────────────────────────

  describe("findNextSafeStart", () => {
    it("returns afterMs when no slots exist", () => {
      const service = new ConflictPreviewService(buildMockRepo([]));
      const result = service.findNextSafeStart("alice", now, HOUR_MS);
      expect(result).toBe(now);
    });

    it("skips over conflicting slots to find safe start", () => {
      const service = new ConflictPreviewService(buildMockRepo([]));
      const slots = [
        { startTime: now, endTime: now + HOUR_MS },
        { startTime: now + HOUR_MS, endTime: now + 2 * HOUR_MS },
      ];
      const result = service.findNextSafeStart("alice", now, HOUR_MS, slots);
      expect(result).toBe(now + 2 * HOUR_MS);
    });

    it("returns the slot end when it is immediately safe", () => {
      const service = new ConflictPreviewService(buildMockRepo([]));
      const safeStart = now + 5 * HOUR_MS;
      const slots = [
        { startTime: now, endTime: safeStart },
      ];
      const result = service.findNextSafeStart("alice", safeStart, HOUR_MS, slots);
      expect(result).toBe(safeStart);
    });
  });

  // ── Detail strings ──────────────────────────────────────────────────────

  describe("detail strings", () => {
    it("includes slot id and time range in overlap detail", async () => {
      const occStart = now + DAY_MS;
      const slot = makeSlot({
        id: "slot-detail",
        professional: "alice",
        startTime: occStart,
        endTime: occStart + HOUR_MS,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occStart, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflicts[0].detail).toContain("slot-detail");
      expect(result.conflicts[0].detail).toContain("Overlaps existing slot");
    });

    it("includes tz-ambiguity in detail when DST detected", async () => {
      const dstDate = alignToSecond(new Date("2026-11-01T06:30:00Z").getTime());
      const slot = makeSlot({
        id: "slot-dst",
        professional: "alice",
        startTime: dstDate,
        endTime: dstDate + HOUR_MS,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(dstDate, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
        timezone: "America/New_York",
        horizonDays: 120,
      });

      expect(result.conflictsFound).toBe(1);
      expect(result.conflicts[0].detail).toContain("Timezone ambiguity");
    });
  });

  // ── Result shape ────────────────────────────────────────────────────────

  describe("result shape", () => {
    it("returns correct horizonEnd", async () => {
      const service = new ConflictPreviewService(buildMockRepo([]));
      const result = await service.previewConflicts({
        rrule: dailyRRule(now + DAY_MS, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.horizonEnd).toBe(now + DEFAULT_HORIZON_DAYS * DAY_MS);
      expect(result.horizonDays).toBe(DEFAULT_HORIZON_DAYS);
    });

    it("returns totalOccurrences matching occurrences within horizon", async () => {
      const service = new ConflictPreviewService(buildMockRepo([]));
      const result = await service.previewConflicts({
        rrule: dailyRRule(now + DAY_MS, 5),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.totalOccurrences).toBe(5);
    });
  });

  // ── Blackout category (reserved) ────────────────────────────────────────

  describe("blackout category", () => {
    it("never produces blackout conflicts (reserved for future use)", async () => {
      const occStart = now + DAY_MS;
      const slot = makeSlot({
        id: "slot-blackout",
        professional: "alice",
        startTime: occStart,
        endTime: occStart + HOUR_MS,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(occStart, 1),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflicts[0].reason).not.toBe("blackout");
    });

    it("buildDetail returns blackout string when reason is blackout", () => {
      const service = new ConflictPreviewService(buildMockRepo([]));
      const detail = (service as any).buildDetail("blackout", "slot-bo", 100, 200);
      expect(detail).toBe("Blackout period; overlaps slot slot-bo [100, 200)");
    });
  });

  // ── Past occurrences (occStart < now) ────────────────────────────────────

  describe("past occurrences", () => {
    it("skips occurrences in the past via continue branch", async () => {
      const pastStart = alignToSecond(now - 3 * DAY_MS);
      const repo = buildMockRepo([]);
      const service = new ConflictPreviewService(repo);

      const result = await service.previewConflicts({
        rrule: dailyRRule(pastStart, 5),
        professional: "alice",
        slotDurationMs: HOUR_MS,
      });

      expect(result.conflictsFound).toBe(0);
      expect(result.conflicts).toEqual([]);
    });
  });

  // ── findNextSafeStart fallback (no profSlots arg) ────────────────────────

  describe("findNextSafeStart fallback", () => {
    it("falls back to repo.list() when profSlots is not provided", () => {
      const slot = makeSlot({
        id: "repo-slot",
        professional: "alice",
        startTime: now,
        endTime: now + HOUR_MS,
      });
      const repo = buildMockRepo([slot]);
      const service = new ConflictPreviewService(repo);

      const result = service.findNextSafeStart("alice", now, HOUR_MS);
      expect(result).toBe(now + HOUR_MS);
    });

    it("returns undefined when no gap exists and profSlots is not provided", () => {
      const manySlots: SlotRecord[] = [];
      for (let i = 0; i < 101; i++) {
        manySlots.push(
          makeSlot({
            id: `slot-dense-${i}`,
            professional: "alice",
            startTime: now + i * HOUR_MS,
            endTime: now + (i + 1) * HOUR_MS,
          }),
        );
      }
      const repo = buildMockRepo(manySlots);
      const service = new ConflictPreviewService(repo);

      const result = service.findNextSafeStart("alice", now, HOUR_MS);
      expect(result).toBeUndefined();
    });
  });
});
