/**
 * Tests for #484 – RRULE EXDATE support and blackout window suppression.
 *
 * Verifies that:
 *  - EXDATE lines in the rrule text are parsed and applied.
 *  - Multiple EXDATE lines and comma-separated values are all handled.
 *  - Blackout windows independently suppress occurrences.
 *  - EXDATEs and blackouts stack (each can independently exclude an occurrence).
 *  - expandRRule() (backward-compat shim) correctly applies EXDATEs.
 *  - HolidayImpactAnalyzer.analyzeSync() respects blackouts.
 *  - parseExdates() rejects oversized lists.
 *  - Invalid EXDATE formats are silently skipped.
 */

import { describe, it, expect } from "@jest/globals";
import {
  expandRRule,
  expandRRuleWithExdate,
  parseExdates,
  RecurrenceError,
  BlackoutWindow,
  MAX_EXDATES,
  HolidayImpactAnalyzer,
  createInMemoryHolidayRegistry,
  RegionalHoliday,
} from "../recurrenceService.js";

// ─── RRULE fixtures ───────────────────────────────────────────────────────────

/**
 * Weekly on Monday, 5 occurrences starting 2026-07-06 (Mon).
 * Dates: 2026-07-06, 2026-07-13, 2026-07-20, 2026-07-27, 2026-08-03
 */
const WEEKLY_MON_5 =
  "DTSTART:20260706T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO";

// ─── parseExdates() ───────────────────────────────────────────────────────────

describe("parseExdates()", () => {
  it("returns empty array when no EXDATE lines present", () => {
    expect(parseExdates(WEEKLY_MON_5)).toHaveLength(0);
  });

  it("parses a single UTC date-time value", () => {
    const text = `${WEEKLY_MON_5}\nEXDATE:20260706T100000Z`;
    const result = parseExdates(text);
    expect(result).toHaveLength(1);
    expect(result[0].toISOString()).toBe("2026-07-06T00:00:00.000Z");
  });

  it("parses a DATE-only EXDATE value", () => {
    const text = `${WEEKLY_MON_5}\nEXDATE:20260713`;
    const result = parseExdates(text);
    expect(result).toHaveLength(1);
    expect(result[0].toISOString()).toBe("2026-07-13T00:00:00.000Z");
  });

  it("parses comma-separated EXDATE values on one line", () => {
    const text = `${WEEKLY_MON_5}\nEXDATE:20260706T100000Z,20260713T100000Z`;
    const result = parseExdates(text);
    expect(result).toHaveLength(2);
  });

  it("parses multiple EXDATE lines", () => {
    const text = `${WEEKLY_MON_5}\nEXDATE:20260706T100000Z\nEXDATE:20260720T100000Z`;
    const result = parseExdates(text);
    expect(result).toHaveLength(2);
  });

  it("handles EXDATE with TZID parameter", () => {
    const text = `${WEEKLY_MON_5}\nEXDATE;TZID=America/New_York:20260706T060000`;
    const result = parseExdates(text);
    expect(result).toHaveLength(1);
  });

  it("silently skips malformed EXDATE value tokens", () => {
    const text = `${WEEKLY_MON_5}\nEXDATE:notadate,20260706T100000Z`;
    const result = parseExdates(text);
    expect(result).toHaveLength(1); // only the valid one
  });

  it("throws RecurrenceError when EXDATE list exceeds MAX_EXDATES", () => {
    const exdateValues = Array.from({ length: MAX_EXDATES + 1 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + i));
      return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T000000Z`;
    }).join(",");
    const text = `DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY;COUNT=200\nEXDATE:${exdateValues}`;
    expect(() => parseExdates(text)).toThrow(RecurrenceError);
  });
});

// ─── expandRRuleWithExdate() ──────────────────────────────────────────────────

describe("expandRRuleWithExdate()", () => {
  it("returns all occurrences when no EXDATE and no blackouts", () => {
    const result = expandRRuleWithExdate(WEEKLY_MON_5);
    expect(result.occurrences).toHaveLength(5);
    expect(result.excludedByExdate).toHaveLength(0);
    expect(result.excludedByBlackout).toHaveLength(0);
  });

  it("removes occurrences matching EXDATE lines", () => {
    const text = `${WEEKLY_MON_5}\nEXDATE:20260706T100000Z`;
    const result = expandRRuleWithExdate(text);
    expect(result.occurrences).toHaveLength(4);
    expect(result.excludedByExdate).toHaveLength(1);
    expect(result.excludedByExdate[0].toISOString()).toContain("2026-07-06");
  });

  it("removes occurrences within a blackout window", () => {
    // Blackout covers 2026-07-13 entirely
    const blackouts: BlackoutWindow[] = [
      {
        startMs: Date.UTC(2026, 6, 13, 0, 0, 0),
        endMs: Date.UTC(2026, 6, 13, 23, 59, 59),
        label: "Company holiday",
      },
    ];
    const result = expandRRuleWithExdate(WEEKLY_MON_5, blackouts);
    expect(result.occurrences).toHaveLength(4);
    expect(result.excludedByBlackout).toHaveLength(1);
    expect(result.excludedByBlackout[0].toISOString()).toContain("2026-07-13");
  });

  it("stacks EXDATE and blackout exclusions independently", () => {
    const text = `${WEEKLY_MON_5}\nEXDATE:20260706T100000Z`;
    const blackouts: BlackoutWindow[] = [
      {
        startMs: Date.UTC(2026, 6, 13, 0, 0, 0),
        endMs: Date.UTC(2026, 6, 13, 23, 59, 59),
      },
    ];
    const result = expandRRuleWithExdate(text, blackouts);
    expect(result.occurrences).toHaveLength(3);
    expect(result.excludedByExdate).toHaveLength(1);
    expect(result.excludedByBlackout).toHaveLength(1);
  });

  it("handles multiple blackout windows", () => {
    const blackouts: BlackoutWindow[] = [
      { startMs: Date.UTC(2026, 6, 6, 0, 0, 0), endMs: Date.UTC(2026, 6, 6, 23, 59, 59) },
      { startMs: Date.UTC(2026, 6, 20, 0, 0, 0), endMs: Date.UTC(2026, 6, 20, 23, 59, 59) },
    ];
    const result = expandRRuleWithExdate(WEEKLY_MON_5, blackouts);
    expect(result.occurrences).toHaveLength(3);
    expect(result.excludedByBlackout).toHaveLength(2);
  });

  it("handles multi-day blackout window spanning multiple occurrences", () => {
    // Block 2026-07-06 through 2026-07-20 (3 Mondays)
    const blackouts: BlackoutWindow[] = [
      {
        startMs: Date.UTC(2026, 6, 6, 0, 0, 0),
        endMs: Date.UTC(2026, 6, 20, 23, 59, 59),
      },
    ];
    const result = expandRRuleWithExdate(WEEKLY_MON_5, blackouts);
    expect(result.occurrences).toHaveLength(2); // 2026-07-27, 2026-08-03
    expect(result.excludedByBlackout).toHaveLength(3);
  });

  it("EXDATE exclusion takes priority (not double-counted in blackout list)", () => {
    // Same date in both EXDATE and blackout
    const text = `${WEEKLY_MON_5}\nEXDATE:20260706T100000Z`;
    const blackouts: BlackoutWindow[] = [
      { startMs: Date.UTC(2026, 6, 6, 0, 0, 0), endMs: Date.UTC(2026, 6, 6, 23, 59, 59) },
    ];
    const result = expandRRuleWithExdate(text, blackouts);
    // The occurrence is excluded by EXDATE first; it should NOT also appear in excludedByBlackout
    expect(result.excludedByExdate).toHaveLength(1);
    expect(result.excludedByBlackout).toHaveLength(0);
    expect(result.occurrences).toHaveLength(4);
  });

  it("throws for unbounded rule", () => {
    expect(() => expandRRuleWithExdate("FREQ=DAILY")).toThrow(RecurrenceError);
  });

  it("throws for empty string", () => {
    expect(() => expandRRuleWithExdate("   ")).toThrow(RecurrenceError);
  });
});

// ─── expandRRule() (backward-compat) ─────────────────────────────────────────

describe("expandRRule() backward compatibility", () => {
  it("still works without EXDATE lines", () => {
    const occ = expandRRule(WEEKLY_MON_5);
    expect(occ).toHaveLength(5);
  });

  it("applies EXDATE lines when present (transparent to caller)", () => {
    const text = `${WEEKLY_MON_5}\nEXDATE:20260706T100000Z,20260713T100000Z`;
    const occ = expandRRule(text);
    expect(occ).toHaveLength(3);
  });
});

// ─── HolidayImpactAnalyzer.analyzeSync() + blackouts ─────────────────────────

describe("HolidayImpactAnalyzer.analyzeSync() with blackouts", () => {
  const holiday: RegionalHoliday = {
    date: "2026-07-27",
    name: "Test Holiday",
    regionCodes: ["DE"],
    observanceType: "full_day",
  };

  it("blackout-suppressed occurrences are not analysed for holiday impact", () => {
    const analyzer = new HolidayImpactAnalyzer({
      holidayRegistry: createInMemoryHolidayRegistry([holiday]),
    });

    // Without blackout: 2026-07-27 occurrence collides with holiday
    const withoutBlackout = analyzer.analyzeSync({
      rruleText: WEEKLY_MON_5,
      scopedRegionCodes: ["DE"],
      resolvedTimezone: "UTC",
      holidays: [holiday],
    });
    expect(withoutBlackout.affectedOccurrences).toBe(1);

    // With blackout covering 2026-07-27: occurrence is removed first, no holiday impact
    const blackouts: BlackoutWindow[] = [
      {
        startMs: Date.UTC(2026, 6, 27, 0, 0, 0),
        endMs: Date.UTC(2026, 6, 27, 23, 59, 59),
        label: "Office closure",
      },
    ];
    const withBlackout = analyzer.analyzeSync({
      rruleText: WEEKLY_MON_5,
      scopedRegionCodes: ["DE"],
      resolvedTimezone: "UTC",
      holidays: [holiday],
      blackouts,
    });
    expect(withBlackout.affectedOccurrences).toBe(0);
    expect(withBlackout.totalOccurrences).toBe(4); // one suppressed by blackout
  });

  it("EXDATE and blackout together reduce totalOccurrences", () => {
    const analyzer = new HolidayImpactAnalyzer({
      holidayRegistry: createInMemoryHolidayRegistry([]),
    });

    const text = `${WEEKLY_MON_5}\nEXDATE:20260706T100000Z`;
    const blackouts: BlackoutWindow[] = [
      { startMs: Date.UTC(2026, 6, 13, 0, 0, 0), endMs: Date.UTC(2026, 6, 13, 23, 59, 59) },
    ];

    const result = analyzer.analyzeSync({
      rruleText: text,
      holidays: [],
      blackouts,
    });

    expect(result.totalOccurrences).toBe(3);
  });
});
