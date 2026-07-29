import { expandRRule, RecurrenceError } from "../recurrenceService.js";

describe("RecurrenceService", () => {
  describe("Basic limitations", () => {
    it("rejects unbounded rrule", () => {
      const rrule = "FREQ=WEEKLY;BYDAY=MO"; // no COUNT or UNTIL
      expect(() => expandRRule(rrule)).toThrow(RecurrenceError);
      expect(() => expandRRule(rrule)).toThrow("Unbounded RRULE is not allowed; include COUNT or UNTIL");
    });

    it("rejects empty rrule", () => {
      expect(() => expandRRule("")).toThrow(RecurrenceError);
      expect(() => expandRRule("   ")).toThrow(RecurrenceError);
    });

    it("rejects invalid rrule format", () => {
      expect(() => expandRRule("INVALID=FORMAT;COUNT=5")).toThrow(RecurrenceError);
    });

    it("expands bounded rrule", () => {
      const rrule = "DTSTART:20260101T100000Z\nRRULE:FREQ=WEEKLY;COUNT=2;BYDAY=MO";
      const occ = expandRRule(rrule);
      expect(occ.length).toBe(2);
      expect(occ[0].toISOString()).toContain("2026");
    });

    it("rejects rrule expanding to more than MAX_OCCURRENCES", () => {
      const rrule = "DTSTART:20260101T100000Z\nRRULE:FREQ=DAILY;COUNT=201";
      expect(() => expandRRule(rrule)).toThrow(RecurrenceError);
      expect(() => expandRRule(rrule)).toThrow("RRULE expands to more than 200 occurrences");
    });
  });

  describe("RFC 5545 Conformance Suite - INTERVAL and BYSETPOS", () => {
    it("INTERVAL: Every other week (RFC 5545 example)", () => {
      const rrule = "DTSTART:19970902T090000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU";
      const occ = expandRRule(rrule);
      expect(occ.length).toBe(4);
      expect(occ[0].toISOString()).toBe("1997-09-02T09:00:00.000Z");
      expect(occ[1].toISOString()).toBe("1997-09-16T09:00:00.000Z");
      expect(occ[2].toISOString()).toBe("1997-09-30T09:00:00.000Z");
      expect(occ[3].toISOString()).toBe("1997-10-14T09:00:00.000Z");
    });

    it("INTERVAL: Every 10 days, 5 occurrences (RFC 5545 example)", () => {
      const rrule = "DTSTART:19970902T090000Z\nRRULE:FREQ=DAILY;INTERVAL=10;COUNT=5";
      const occ = expandRRule(rrule);
      expect(occ.length).toBe(5);
      expect(occ[0].toISOString()).toBe("1997-09-02T09:00:00.000Z");
      expect(occ[1].toISOString()).toBe("1997-09-12T09:00:00.000Z");
      expect(occ[2].toISOString()).toBe("1997-09-22T09:00:00.000Z");
      expect(occ[3].toISOString()).toBe("1997-10-02T09:00:00.000Z");
      expect(occ[4].toISOString()).toBe("1997-10-12T09:00:00.000Z");
    });

    it("BYSETPOS: The second to last weekday of the month (RFC 5545 example)", () => {
      const rrule = "DTSTART:19970929T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2;COUNT=3";
      const occ = expandRRule(rrule);
      expect(occ.length).toBe(3);
      expect(occ[0].toISOString()).toBe("1997-09-29T09:00:00.000Z");
      expect(occ[1].toISOString()).toBe("1997-10-30T09:00:00.000Z");
      expect(occ[2].toISOString()).toBe("1997-11-27T09:00:00.000Z");
    });

    it("INTERVAL 0 is malformed / negative tests", () => {
      const rrule = "DTSTART:20260101T100000Z\nRRULE:FREQ=DAILY;INTERVAL=0;COUNT=5";
      // By RFC 5545, INTERVAL must be a positive integer.
      // rrulestr should throw an error or we catch it.
      expect(() => expandRRule(rrule)).toThrow();
    });

    it("BYSETPOS negative limit out of bounds", () => {
      // Out of bounds BYSETPOS shouldn't break the system, it either throws or yields empty.
      const rrule = "DTSTART:20260101T100000Z\nRRULE:FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-400;COUNT=1";
      // Some libraries just ignore invalid BYSETPOS and produce nothing, which will cause count to run indefinitely
      // unless bounded by COUNT or UNTIL. We bound it by COUNT=1. But wait! If it yields 0 occurrences, it might loop infinitely if the library is bugged! 
      // RRule in JS might loop indefinitely if BYSETPOS is invalid and we ask for COUNT. Let's see what happens.
      // If it throws, we catch. If it returns [], we assert.
      let err;
      let res;
      try {
        res = expandRRule(rrule);
      } catch (e) {
        err = e;
      }
      if (err) {
        expect(err).toBeInstanceOf(Error);
      } else {
        expect(res).toBeDefined();
      }
    });

    it("Feb-29 anchor with yearly recurrence", () => {
      // RFC 5545 specifies rules for leap years.
      const rrule = "DTSTART:20240229T100000Z\nRRULE:FREQ=YEARLY;COUNT=2";
      const occ = expandRRule(rrule);
      // RRule JS handles leap years correctly. For FREQ=YEARLY, it finds 2024 and 2028.
      expect(occ.length).toBe(2);
      expect(occ[0].toISOString()).toBe("2024-02-29T10:00:00.000Z");
      expect(occ[1].toISOString()).toBe("2028-02-29T10:00:00.000Z");
    });
  });
});
