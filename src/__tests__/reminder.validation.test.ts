/**
 * Tests for reminder schedule validation and timezone handling.
 *
 * Covers:
 * - IANA timezone identifier validation
 * - DST transition detection (fall-back and spring-forward)
 * - Full business-rule validation (lead time, look-ahead, types)
 * - Service-level type validation via scheduleReminders
 * - Security: error messages must not echo raw input values
 */

import {
  isValidIANATimezone,
  isInDSTTransition,
  validateReminderScheduleInput,
  DEFAULT_REMINDER_TIMEZONE,
  MIN_SCHEDULE_LEAD_TIME_MS,
  MAX_SCHEDULE_LOOK_AHEAD_MS,
} from "../validation/reminderValidation.js";
import { scheduleReminders } from "../services/reminderService.js";
import { ReminderValidationError } from "../types/reminder.js";
import { ReminderStore } from "../models/reminder.js";

// ---------------------------------------------------------------------------
// isValidIANATimezone
// ---------------------------------------------------------------------------

describe("isValidIANATimezone", () => {
  it("accepts well-known IANA timezone identifiers", () => {
    expect(isValidIANATimezone("UTC")).toBe(true);
    expect(isValidIANATimezone("America/New_York")).toBe(true);
    expect(isValidIANATimezone("Europe/London")).toBe(true);
    expect(isValidIANATimezone("Asia/Tokyo")).toBe(true);
    expect(isValidIANATimezone("Australia/Sydney")).toBe(true);
    expect(isValidIANATimezone("Pacific/Auckland")).toBe(true);
    expect(isValidIANATimezone("America/Chicago")).toBe(true);
    expect(isValidIANATimezone("Europe/Paris")).toBe(true);
  });

  it("rejects unrecognised timezone strings", () => {
    expect(isValidIANATimezone("America/NotACity")).toBe(false);
    expect(isValidIANATimezone("Fake/Zone")).toBe(false);
    expect(isValidIANATimezone("completely invalid")).toBe(false);
    expect(isValidIANATimezone("GMT+garbage")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidIANATimezone("")).toBe(false);
  });

  it("rejects whitespace-only strings", () => {
    expect(isValidIANATimezone("   ")).toBe(false);
    expect(isValidIANATimezone("\t")).toBe(false);
    expect(isValidIANATimezone("\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isInDSTTransition
// ---------------------------------------------------------------------------

describe("isInDSTTransition", () => {
  // America/New_York DST fall-back: first Sunday of November.
  // 2024-11-03: clocks fall back at 2:00 AM EDT (= 06:00 UTC).
  const NY_FALL_BACK_2024 = new Date("2024-11-03T06:00:00Z").getTime();

  // America/New_York DST spring-forward: second Sunday of March.
  // 2024-03-10: clocks spring forward at 2:00 AM EST (= 07:00 UTC).
  const NY_SPRING_FORWARD_2024 = new Date("2024-03-10T07:00:00Z").getTime();

  it("detects fall-back DST transition for America/New_York (Nov 2024)", () => {
    expect(isInDSTTransition(NY_FALL_BACK_2024, "America/New_York")).toBe(true);
  });

  it("detects spring-forward DST transition for America/New_York (Mar 2024)", () => {
    expect(isInDSTTransition(NY_SPRING_FORWARD_2024, "America/New_York")).toBe(true);
  });

  it("returns false for UTC which observes no DST", () => {
    expect(isInDSTTransition(NY_FALL_BACK_2024, "UTC")).toBe(false);
    expect(isInDSTTransition(NY_SPRING_FORWARD_2024, "UTC")).toBe(false);
  });

  it("returns false for a mid-summer timestamp in a DST-observing timezone", () => {
    // July 15 is well inside EDT — no transition nearby
    const midSummer2024 = new Date("2024-07-15T12:00:00Z").getTime();
    expect(isInDSTTransition(midSummer2024, "America/New_York")).toBe(false);
  });

  it("returns false for a mid-winter timestamp in a DST-observing timezone", () => {
    // January 20 is well inside EST — no transition nearby
    const midWinter2024 = new Date("2024-01-20T12:00:00Z").getTime();
    expect(isInDSTTransition(midWinter2024, "America/New_York")).toBe(false);
  });

  it("returns false for a timezone that never observes DST (Asia/Tokyo)", () => {
    expect(isInDSTTransition(NY_FALL_BACK_2024, "Asia/Tokyo")).toBe(false);
    expect(isInDSTTransition(NY_SPRING_FORWARD_2024, "Asia/Tokyo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateReminderScheduleInput
// ---------------------------------------------------------------------------

describe("validateReminderScheduleInput", () => {
  // Fixed "now" so tests are fully deterministic regardless of wall-clock time
  const NOW = 1_700_000_000_000;
  const VALID_START = NOW + MIN_SCHEDULE_LEAD_TIME_MS + 5_000;

  // --- happy paths ---

  describe("valid inputs", () => {
    it("returns valid result with UTC as default resolvedTimezone", () => {
      const result = validateReminderScheduleInput(1, VALID_START, undefined, NOW);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.normalizedStartTime).toBe(VALID_START);
      expect(result.resolvedTimezone).toBe(DEFAULT_REMINDER_TIMEZONE);
    });

    it("resolves a provided IANA timezone", () => {
      const result = validateReminderScheduleInput(1, VALID_START, "America/New_York", NOW);

      expect(result.valid).toBe(true);
      expect(result.resolvedTimezone).toBe("America/New_York");
      expect(result.normalizedStartTime).toBe(VALID_START);
    });

    it("accepts the largest slotId that is a safe integer", () => {
      const result = validateReminderScheduleInput(Number.MAX_SAFE_INTEGER, VALID_START, undefined, NOW);
      expect(result.valid).toBe(true);
    });

    it("accepts startTime exactly at the minimum lead time boundary", () => {
      const exactMin = NOW + MIN_SCHEDULE_LEAD_TIME_MS;
      const result = validateReminderScheduleInput(1, exactMin, undefined, NOW);
      expect(result.valid).toBe(true);
    });

    it("accepts startTime just inside the maximum look-ahead", () => {
      const nearMax = NOW + MAX_SCHEDULE_LOOK_AHEAD_MS - 1_000;
      const result = validateReminderScheduleInput(1, nearMax, undefined, NOW);
      expect(result.valid).toBe(true);
    });

    it("defaults resolvedTimezone to UTC when null is passed", () => {
      const result = validateReminderScheduleInput(1, VALID_START, null, NOW);
      expect(result.valid).toBe(true);
      expect(result.resolvedTimezone).toBe("UTC");
    });
  });

  // --- slotId validation ---

  describe("slotId validation", () => {
    it.each([
      [0, "zero"],
      [-1, "negative integer"],
      [-100, "large negative"],
      [1.5, "float"],
      [0.1, "small float"],
      [NaN, "NaN"],
    ])("rejects slotId %s (%s)", (slotId) => {
      const result = validateReminderScheduleInput(slotId, VALID_START, undefined, NOW);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("slotId"))).toBe(true);
    });

    it("rejects a string slotId", () => {
      const result = validateReminderScheduleInput("1", VALID_START, undefined, NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects a null slotId", () => {
      const result = validateReminderScheduleInput(null, VALID_START, undefined, NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects an undefined slotId", () => {
      const result = validateReminderScheduleInput(undefined, VALID_START, undefined, NOW);
      expect(result.valid).toBe(false);
    });
  });

  // --- startTime validation ---

  describe("startTime validation", () => {
    it("rejects a string startTime", () => {
      const result = validateReminderScheduleInput(1, "bad-value", undefined, NOW);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("startTime"))).toBe(true);
    });

    it("rejects Infinity", () => {
      const result = validateReminderScheduleInput(1, Infinity, undefined, NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects negative Infinity", () => {
      const result = validateReminderScheduleInput(1, -Infinity, undefined, NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects NaN", () => {
      const result = validateReminderScheduleInput(1, NaN, undefined, NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects a float startTime", () => {
      const result = validateReminderScheduleInput(1, NOW + 90_000.5, undefined, NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects startTime in the past", () => {
      const result = validateReminderScheduleInput(1, NOW - 1_000, undefined, NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects startTime equal to now", () => {
      const result = validateReminderScheduleInput(1, NOW, undefined, NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects startTime just short of the minimum lead time", () => {
      const tooSoon = NOW + MIN_SCHEDULE_LEAD_TIME_MS - 1;
      const result = validateReminderScheduleInput(1, tooSoon, undefined, NOW);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("startTime"))).toBe(true);
    });

    it("rejects startTime beyond the maximum look-ahead", () => {
      const tooFar = NOW + MAX_SCHEDULE_LOOK_AHEAD_MS + 1_000;
      const result = validateReminderScheduleInput(1, tooFar, undefined, NOW);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("1 year"))).toBe(true);
    });

    it("rejects null startTime", () => {
      const result = validateReminderScheduleInput(1, null, undefined, NOW);
      expect(result.valid).toBe(false);
    });
  });

  // --- timezone validation ---

  describe("timezone validation", () => {
    it("accepts undefined and resolves to UTC", () => {
      const result = validateReminderScheduleInput(1, VALID_START, undefined, NOW);
      expect(result.valid).toBe(true);
      expect(result.resolvedTimezone).toBe("UTC");
    });

    it("rejects an unrecognised timezone string", () => {
      const result = validateReminderScheduleInput(1, VALID_START, "Fake/Zone", NOW);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("timezone"))).toBe(true);
    });

    it("rejects an empty timezone string", () => {
      const result = validateReminderScheduleInput(1, VALID_START, "", NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects a whitespace-only timezone string", () => {
      const result = validateReminderScheduleInput(1, VALID_START, "   ", NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects a numeric timezone value", () => {
      const result = validateReminderScheduleInput(1, VALID_START, 5, NOW);
      expect(result.valid).toBe(false);
    });

    it("rejects a boolean timezone value", () => {
      const result = validateReminderScheduleInput(1, VALID_START, true, NOW);
      expect(result.valid).toBe(false);
    });

    it("accepts Europe/London", () => {
      const result = validateReminderScheduleInput(1, VALID_START, "Europe/London", NOW);
      expect(result.valid).toBe(true);
      expect(result.resolvedTimezone).toBe("Europe/London");
    });

    it("accepts Asia/Kolkata (half-hour offset timezone)", () => {
      const result = validateReminderScheduleInput(1, VALID_START, "Asia/Kolkata", NOW);
      expect(result.valid).toBe(true);
    });
  });

  // --- multiple errors reported in one pass ---

  describe("multi-error aggregation", () => {
    it("reports violations for every invalid field simultaneously", () => {
      const result = validateReminderScheduleInput(0, -1, "Invalid/Zone", NOW);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
      expect(result.errors.some((e) => e.includes("slotId"))).toBe(true);
      expect(result.errors.some((e) => e.includes("startTime"))).toBe(true);
      expect(result.errors.some((e) => e.includes("timezone"))).toBe(true);
    });

    it("reports both slotId and startTime errors when both are invalid", () => {
      const result = validateReminderScheduleInput(-5, NaN, undefined, NOW);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it("defaults resolvedTimezone to UTC when validation fails", () => {
      const result = validateReminderScheduleInput(0, -1, undefined, NOW);
      expect(result.resolvedTimezone).toBe(DEFAULT_REMINDER_TIMEZONE);
    });
  });

  // --- security: error messages must not echo raw input values ---

  describe("security — no raw values in error messages", () => {
    it("does not echo a negative slotId in error text", () => {
      const result = validateReminderScheduleInput(-99, VALID_START, undefined, NOW);
      for (const msg of result.errors) {
        expect(msg).not.toContain("-99");
      }
    });

    it("does not echo a large invalid startTime in error text", () => {
      const result = validateReminderScheduleInput(1, -123456789, undefined, NOW);
      for (const msg of result.errors) {
        expect(msg).not.toContain("-123456789");
      }
    });

    it("does not echo an invalid timezone string in error text", () => {
      const injected = "Injected<script>alert(1)</script>";
      const result = validateReminderScheduleInput(1, VALID_START, injected, NOW);
      for (const msg of result.errors) {
        expect(msg).not.toContain(injected);
        expect(msg).not.toContain("<script>");
      }
    });

    it("does not echo a numeric timezone value in error text", () => {
      const result = validateReminderScheduleInput(1, VALID_START, 9999, NOW);
      for (const msg of result.errors) {
        expect(msg).not.toContain("9999");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// scheduleReminders — service-level validation
// ---------------------------------------------------------------------------

describe("scheduleReminders with type validation", () => {
  beforeEach(() => {
    ReminderStore.reset();
  });

  it("throws ReminderValidationError when slotId is zero", () => {
    expect(() => scheduleReminders(0, Date.now() + 100_000)).toThrow(ReminderValidationError);
  });

  it("throws ReminderValidationError when slotId is negative", () => {
    expect(() => scheduleReminders(-1, Date.now() + 100_000)).toThrow(ReminderValidationError);
  });

  it("throws ReminderValidationError when slotId is a float", () => {
    expect(() =>
      scheduleReminders(1.5 as unknown as number, Date.now() + 100_000),
    ).toThrow(ReminderValidationError);
  });

  it("throws ReminderValidationError when startTime is NaN", () => {
    expect(() => scheduleReminders(1, NaN)).toThrow(ReminderValidationError);
  });

  it("throws ReminderValidationError when startTime is Infinity", () => {
    expect(() => scheduleReminders(1, Infinity)).toThrow(ReminderValidationError);
  });

  it("throws ReminderValidationError when startTime is negative", () => {
    expect(() => scheduleReminders(1, -1)).toThrow(ReminderValidationError);
  });

  it("throws ReminderValidationError when startTime is zero", () => {
    expect(() => scheduleReminders(1, 0)).toThrow(ReminderValidationError);
  });

  it("throws ReminderValidationError when timezone is unrecognised", () => {
    expect(() =>
      scheduleReminders(1, Date.now() + 100_000, "Not/A/Timezone"),
    ).toThrow(ReminderValidationError);
  });

  it("does not throw when a valid IANA timezone is supplied", () => {
    expect(() =>
      scheduleReminders(1, Date.now() + 2 * 60 * 60_000, "Europe/Paris"),
    ).not.toThrow();
  });

  it("does not throw when timezone is undefined", () => {
    expect(() =>
      scheduleReminders(1, Date.now() + 2 * 60 * 60_000),
    ).not.toThrow();
  });

  it("the thrown error carries an issues array without raw values", () => {
    try {
      scheduleReminders(0, -5_000);
    } catch (err) {
      expect(err).toBeInstanceOf(ReminderValidationError);
      const ve = err as ReminderValidationError;
      expect(Array.isArray(ve.issues)).toBe(true);
      expect(ve.issues.length).toBeGreaterThan(0);
      for (const issue of ve.issues) {
        expect(issue).not.toContain("-5000");
      }
    }
  });

  it("the error message is human-readable and references field names", () => {
    try {
      scheduleReminders(0, Date.now() + 100_000);
    } catch (err) {
      expect(err).toBeInstanceOf(ReminderValidationError);
      expect((err as Error).message).toMatch(/slotId/);
    }
  });
});

// ---------------------------------------------------------------------------
// ReminderValidationError
// ---------------------------------------------------------------------------

describe("ReminderValidationError", () => {
  it("sets the name to ReminderValidationError", () => {
    const err = new ReminderValidationError(["some issue"]);
    expect(err.name).toBe("ReminderValidationError");
  });

  it("exposes all issues in the issues array", () => {
    const issues = ["slotId must be a positive integer", "startTime is invalid"];
    const err = new ReminderValidationError(issues);
    expect(err.issues).toEqual(issues);
  });

  it("includes each issue in the error message", () => {
    const err = new ReminderValidationError(["issue one", "issue two"]);
    expect(err.message).toContain("issue one");
    expect(err.message).toContain("issue two");
  });

  it("is an instance of Error", () => {
    const err = new ReminderValidationError(["x"]);
    expect(err).toBeInstanceOf(Error);
  });
});
