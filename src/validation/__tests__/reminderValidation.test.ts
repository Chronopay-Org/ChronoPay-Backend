import {
  DEFAULT_REMINDER_TIMEZONE,
  MIN_SCHEDULE_LEAD_TIME_MS,
  MAX_SCHEDULE_LOOK_AHEAD_MS,
  isValidIANATimezone,
  isInDSTTransition,
  validateReminderScheduleInput,
} from "../reminderValidation.js";

describe("reminderValidation", () => {
  describe("isValidIANATimezone", () => {
    it("should return true for valid IANA timezones", () => {
      expect(isValidIANATimezone("UTC")).toBe(true);
      expect(isValidIANATimezone("America/New_York")).toBe(true);
      expect(isValidIANATimezone("Europe/London")).toBe(true);
      expect(isValidIANATimezone("Asia/Tokyo")).toBe(true);
    });

    it("should return false for invalid timezones", () => {
      expect(isValidIANATimezone("Fake/Timezone")).toBe(false);
      expect(isValidIANATimezone("")).toBe(false);
      expect(isValidIANATimezone("   ")).toBe(false);
      expect(isValidIANATimezone(null as any)).toBe(false);
      expect(isValidIANATimezone(undefined as any)).toBe(false);
      expect(isValidIANATimezone(123 as any)).toBe(false);
    });
  });

  describe("isInDSTTransition", () => {
    it("should return true when crossing a DST boundary", () => {
      // Europe/London spring forward: 2024-03-31 01:00 UTC
      const springForwardMs = Date.UTC(2024, 2, 31, 1, 0, 0); // March 31, 2024
      expect(isInDSTTransition(springForwardMs, "Europe/London")).toBe(true);

      // Europe/London fall back: 2024-10-27 01:00 UTC
      const fallBackMs = Date.UTC(2024, 9, 27, 1, 0, 0); // Oct 27, 2024
      expect(isInDSTTransition(fallBackMs, "Europe/London")).toBe(true);
    });

    it("should return false outside of DST transitions", () => {
      // Middle of summer
      const summerMs = Date.UTC(2024, 6, 1, 12, 0, 0);
      expect(isInDSTTransition(summerMs, "Europe/London")).toBe(false);

      // Timezone without DST
      expect(isInDSTTransition(summerMs, "UTC")).toBe(false);
      expect(isInDSTTransition(summerMs, "Asia/Tokyo")).toBe(false);
    });
    
    it("should handle GMT style offsets", () => {
      // Edge cases that exercise the GMT matcher
      const someMs = Date.UTC(2024, 6, 1, 12, 0, 0);
      expect(isInDSTTransition(someMs, "Etc/GMT+4")).toBe(false);
    });
  });

  describe("validateReminderScheduleInput", () => {
    const NOW = 1000000000000; // arbitrary fixed epoch time
    const VALID_START = NOW + MIN_SCHEDULE_LEAD_TIME_MS + 1000;

    it("should accept valid inputs", () => {
      const result = validateReminderScheduleInput(1, VALID_START, "America/New_York", NOW);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.normalizedStartTime).toBe(VALID_START);
      expect(result.resolvedTimezone).toBe("America/New_York");
    });

    it("should fall back to default timezone if none provided", () => {
      const result = validateReminderScheduleInput(1, VALID_START, undefined, NOW);
      expect(result.valid).toBe(true);
      expect(result.resolvedTimezone).toBe(DEFAULT_REMINDER_TIMEZONE);
    });
    
    it("should reject timezone if empty or whitespace", () => {
      const result = validateReminderScheduleInput(1, VALID_START, "   ", NOW);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("timezone must be a non-empty string when provided");
    });

    it("should reject missing or invalid slotId (recipient equivalent)", () => {
      const invalidSlotIds = [
        null,
        undefined,
        "1",
        -1,
        0,
        1.5,
      ];
      
      for (const invalid of invalidSlotIds) {
        const result = validateReminderScheduleInput(invalid, VALID_START, undefined, NOW);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("slotId must be a positive integer");
      }
    });

    it("should reject non-number startTimes", () => {
      const invalidStartTimes = [
        null,
        undefined,
        "10000",
        NaN,
        Infinity,
        -Infinity,
      ];
      
      for (const invalid of invalidStartTimes) {
        const result = validateReminderScheduleInput(1, invalid, undefined, NOW);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("startTime must be a finite number (epoch milliseconds)");
      }
    });

    it("should reject non-integer startTimes", () => {
      const result = validateReminderScheduleInput(1, VALID_START + 0.5, undefined, NOW);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("startTime must be an integer (epoch milliseconds)");
    });

    it("should reject startTime in the past or without enough lead time (past sendAt)", () => {
      // Exactly at NOW
      let result = validateReminderScheduleInput(1, NOW, undefined, NOW);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/startTime must be at least \d+ seconds in the future/);

      // In the past
      result = validateReminderScheduleInput(1, NOW - 1000, undefined, NOW);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/startTime must be at least \d+ seconds in the future/);

      // In the future but less than MIN_SCHEDULE_LEAD_TIME_MS
      result = validateReminderScheduleInput(1, NOW + MIN_SCHEDULE_LEAD_TIME_MS - 1, undefined, NOW);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/startTime must be at least \d+ seconds in the future/);
    });

    it("should reject far-future startTimes", () => {
      const farFuture = NOW + MAX_SCHEDULE_LOOK_AHEAD_MS + 1000;
      const result = validateReminderScheduleInput(1, farFuture, undefined, NOW);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("startTime must not be more than 1 year in the future");
    });

    it("should reject invalid timezones", () => {
      const result = validateReminderScheduleInput(1, VALID_START, "Invalid/Timezone", NOW);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "timezone must be a valid IANA timezone identifier (e.g. America/New_York, Europe/London)"
      );
    });
    
    it("should accumulate multiple errors", () => {
      const result = validateReminderScheduleInput(-1, NOW - 1000, "Invalid/Timezone", NOW);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(3);
    });
  });
});
