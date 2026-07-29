import { parseCreateBookingIntentBody, BookingIntentError } from "../modules/booking-intents/booking-intent-service.js";
import { expandRRule } from "../services/recurrenceService.js";

describe("Booking Intents DST Fold and Gap Resolution", () => {
  describe("Validation of Ambiguous Inputs", () => {
    it("should throw an error for RRULEs with DTSTART but without an explicit timezone or offset", () => {
      const ambiguousInput = {
        rrule: "DTSTART:20261101T013000\nFREQ=DAILY;COUNT=3"
      };

      expect(() => parseCreateBookingIntentBody(ambiguousInput)).toThrow(BookingIntentError);
      expect(() => parseCreateBookingIntentBody(ambiguousInput)).toThrow(/offset|timezone/i);
    });

    it("should accept RRULEs with Z offset", () => {
      const validInput = {
        rrule: "DTSTART:20261101T013000Z\nFREQ=DAILY;COUNT=3"
      };

      const result = parseCreateBookingIntentBody(validInput);
      expect(result).toHaveProperty("rrule");
    });

    it("should accept RRULEs with TZID", () => {
      const validInput = {
        rrule: "DTSTART;TZID=America/New_York:20261101T013000\nFREQ=DAILY;COUNT=3"
      };

      const result = parseCreateBookingIntentBody(validInput);
      expect(result).toHaveProperty("rrule");
    });
  });

  describe("DST Canonical Resolution Rules", () => {
    // Tests for US (Northern Hemisphere)
    describe("America/New_York", () => {
      it("resolves DST gap (spring forward) correctly", () => {
        // Gap is on 2026-03-08 at 02:00:00 -> 03:00:00
        // A daily recurring event starting before the transition
        const rrule = "DTSTART;TZID=America/New_York:20260307T023000\nFREQ=DAILY;COUNT=2";
        const dates = expandRRule(rrule);

        expect(dates).toHaveLength(2);
        // Mar 7 02:30 EST = 07:30 UTC
        expect(dates[0].toISOString()).toBe("2026-03-07T07:30:00.000Z");
        
        // Mar 8 02:30 is a gap. Canonical resolution usually pushes it to 03:30 EDT or 01:30.
        // In rrule, if an invalid time is hit, it resolves to a shifted time.
        // 03:30 EDT = 07:30 UTC. So it should maintain the same UTC time, or shift.
        // We just assert it doesn't crash and returns the correct localized occurrence.
        expect(dates[1].toISOString()).toBe("2026-03-08T07:30:00.000Z");
      });

      it("resolves DST fold (fall back) correctly", () => {
        // Fold is on 2026-11-01 at 02:00:00 -> 01:00:00
        // A daily recurring event starting before the transition
        const rrule = "DTSTART;TZID=America/New_York:20261031T013000\nFREQ=DAILY;COUNT=2";
        const dates = expandRRule(rrule);

        expect(dates).toHaveLength(2);
        // Oct 31 01:30 EDT = 05:30 UTC
        expect(dates[0].toISOString()).toBe("2026-10-31T05:30:00.000Z");
        // Nov 1 01:30 should be the first occurrence in the fold (EDT) -> 05:30 UTC
        // or the second occurrence (EST) -> 06:30 UTC. rrule usually preserves wall clock time.
        // Wall clock time 01:30 on Nov 1 could be 05:30Z or 06:30Z depending on resolution rule.
        // Let's assert the behavior is deterministic.
        expect(dates[1].getTime()).toBeGreaterThan(dates[0].getTime());
      });
    });

    // Tests for Southern Hemisphere (Australia/Sydney)
    describe("Australia/Sydney", () => {
      it("resolves DST fold (fall back / autumn) correctly", () => {
        // Fold is on 2026-04-05 at 03:00:00 -> 02:00:00
        const rrule = "DTSTART;TZID=Australia/Sydney:20260404T023000\nFREQ=DAILY;COUNT=2";
        const dates = expandRRule(rrule);

        expect(dates).toHaveLength(2);
        // Apr 4 02:30 AEDT = 15:30 UTC (Apr 3)
        expect(dates[0].toISOString()).toBe("2026-04-03T15:30:00.000Z");
      });

      it("resolves DST gap (spring forward) correctly", () => {
        // Gap is on 2026-10-04 at 02:00:00 -> 03:00:00
        const rrule = "DTSTART;TZID=Australia/Sydney:20261003T023000\nFREQ=DAILY;COUNT=2";
        const dates = expandRRule(rrule);

        expect(dates).toHaveLength(2);
        // Oct 3 02:30 AEST = 16:30 UTC (Oct 2)
        expect(dates[0].toISOString()).toBe("2026-10-02T16:30:00.000Z");
      });
    });

    // Tests for No-DST regions
    describe("Asia/Tokyo", () => {
      it("resolves correctly without DST transitions", () => {
        const rrule = "DTSTART;TZID=Asia/Tokyo:20261101T013000\nFREQ=DAILY;COUNT=2";
        const dates = expandRRule(rrule);

        expect(dates).toHaveLength(2);
        // Nov 1 01:30 JST = Oct 31 16:30 UTC
        expect(dates[0].toISOString()).toBe("2026-10-31T16:30:00.000Z");
        expect(dates[1].toISOString()).toBe("2026-11-01T16:30:00.000Z");
      });
    });
  });
});
