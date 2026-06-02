import { expandRRule, RecurrenceError } from "../recurrenceService.js";

describe("RecurrenceService", () => {
  it("rejects unbounded rrule", () => {
    const rrule = "FREQ=WEEKLY;BYDAY=MO"; // no COUNT or UNTIL
    expect(() => expandRRule(rrule)).toThrow(RecurrenceError);
  });

  it("expands bounded rrule", () => {
    const rrule = "DTSTART:20260101T100000Z\nRRULE:FREQ=WEEKLY;COUNT=2;BYDAY=MO";
    const occ = expandRRule(rrule);
    expect(occ.length).toBe(2);
    expect(occ[0].toISOString()).toContain("2026");
  });
});
