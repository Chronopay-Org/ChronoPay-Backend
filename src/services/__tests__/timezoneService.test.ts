import {
  isValidIANATimezone,
  resolveTimezone,
  formatToTimezoneOffset,
  normalizeSlotTimes,
  normalizeSlots,
  
} from "../timezoneService.js";

describe("timezoneService", () => {
  describe("isValidIANATimezone", () => {
    it("accepts valid IANA timezones", () => {
      expect(isValidIANATimezone("UTC")).toBe(true);
      expect(isValidIANATimezone("America/New_York")).toBe(true);
      expect(isValidIANATimezone("Europe/London")).toBe(true);
      expect(isValidIANATimezone("Asia/Kolkata")).toBe(true);
      expect(isValidIANATimezone("Pacific/Auckland")).toBe(true);
    });

    it("rejects empty strings", () => {
      expect(isValidIANATimezone("")).toBe(false);
      expect(isValidIANATimezone("   ")).toBe(false);
    });

    it("rejects non-string values", () => {
      expect(isValidIANATimezone(undefined as any)).toBe(false);
      expect(isValidIANATimezone(null as any)).toBe(false);
      expect(isValidIANATimezone(42 as any)).toBe(false);
      expect(isValidIANATimezone({} as any)).toBe(false);
    });

    it("rejects invalid timezone strings", () => {
      expect(isValidIANATimezone("Not/A/Timezone")).toBe(false);
      expect(isValidIANATimezone("America/")).toBe(false);
      expect(isValidIANATimezone("foo/bar/baz")).toBe(false);
      expect(isValidIANATimezone("Local")).toBe(false);
      expect(isValidIANATimezone("123")).toBe(false);
    });
  });

  describe("resolveTimezone", () => {
    it("returns profile timezone when valid IANA", () => {
      expect(resolveTimezone("America/New_York", "Europe/London")).toBe("America/New_York");
    });

    it("falls back to header when profile is null", () => {
      expect(resolveTimezone(null, "Europe/London")).toBe("Europe/London");
    });

    it("falls back to header when profile is undefined", () => {
      expect(resolveTimezone(undefined, "Europe/London")).toBe("Europe/London");
    });

    it("falls back to header when profile is invalid IANA", () => {
      expect(resolveTimezone("Not/A/Tz", "Europe/London")).toBe("Europe/London");
    });

    it("falls back to UTC when both are null", () => {
      expect(resolveTimezone(null, null)).toBe("UTC");
    });

    it("falls back to UTC when both are undefined", () => {
      expect(resolveTimezone(undefined, undefined)).toBe("UTC");
    });

    it("falls back to UTC when both are invalid", () => {
      expect(resolveTimezone("Not/A/Tz", "Also/Invalid")).toBe("UTC");
    });

    it("falls back to UTC when header is invalid and profile is null", () => {
      expect(resolveTimezone(null, "NotATz")).toBe("UTC");
    });

    it("returns UTC as default", () => {
      expect(resolveTimezone()).toBe("UTC");
    });

    it("prefers profile even when header is also valid", () => {
      expect(resolveTimezone("Asia/Tokyo", "America/Chicago")).toBe("Asia/Tokyo");
    });
  });

  describe("formatToTimezoneOffset", () => {
    const fixedUtcMs = Date.UTC(2026, 0, 15, 14, 30, 0); // 2026-01-15T14:30:00Z

    it("formats UTC time with +00:00 offset", () => {
      const result = formatToTimezoneOffset(fixedUtcMs, "UTC");
      expect(result).toBe("2026-01-15T14:30:00+00:00");
    });

    it("formats time in America/New_York (EST in January)", () => {
      const result = formatToTimezoneOffset(fixedUtcMs, "America/New_York");
      expect(result).toBe("2026-01-15T09:30:00-05:00");
    });

    it("formats time in Asia/Kolkata (IST, +5:30)", () => {
      const result = formatToTimezoneOffset(fixedUtcMs, "Asia/Kolkata");
      expect(result).toBe("2026-01-15T20:00:00+05:30");
    });

    it("formats time in Europe/London (GMT in January)", () => {
      const result = formatToTimezoneOffset(fixedUtcMs, "Europe/London");
      expect(result).toBe("2026-01-15T14:30:00+00:00");
    });

    it("handles DST transitions (America/New_York in July = EDT)", () => {
      // 2026-07-15T14:30:00Z -> EDT (UTC-4)
      const summerMs = Date.UTC(2026, 6, 15, 14, 30, 0);
      const result = formatToTimezoneOffset(summerMs, "America/New_York");
      expect(result).toBe("2026-07-15T10:30:00-04:00");
    });

    it("returns null for non-finite timestamps", () => {
      expect(formatToTimezoneOffset(NaN, "UTC")).toBeNull();
      expect(formatToTimezoneOffset(Infinity, "UTC")).toBeNull();
      expect(formatToTimezoneOffset(-Infinity, "UTC")).toBeNull();
    });

    it("returns null for invalid timezone", () => {
      expect(formatToTimezoneOffset(fixedUtcMs, "NotATimezone")).toBeNull();
    });

    it("returns null for non-string timezone", () => {
      expect(formatToTimezoneOffset(fixedUtcMs, 42 as any)).toBeNull();
    });

    it("handles midnight crossing (23:00 UTC in UTC+1 = 00:00 next day)", () => {
      const midnightUtc = Date.UTC(2026, 0, 15, 23, 0, 0);
      const result = formatToTimezoneOffset(midnightUtc, "Europe/Berlin");
      // CET = UTC+1 -> 2026-01-16T00:00:00+01:00
      expect(result).toBe("2026-01-16T00:00:00+01:00");
    });
  });

  describe("normalizeSlotTimes", () => {
    const slot = {
      id: "slot-1",
      professional: "Dr. Smith",
      startTime: Date.UTC(2026, 5, 10, 14, 0, 0),
      endTime: Date.UTC(2026, 5, 10, 15, 0, 0),
    };

    it("adds startTimeLocal, endTimeLocal, and timezone fields", () => {
      const result = normalizeSlotTimes(slot, "America/New_York");
      expect(result).toHaveProperty("startTimeLocal");
      expect(result).toHaveProperty("endTimeLocal");
      expect(result).toHaveProperty("timezone", "America/New_York");
    });

    it("preserves original startTime and endTime", () => {
      const result = normalizeSlotTimes(slot, "America/New_York");
      expect(result.startTime).toBe(slot.startTime);
      expect(result.endTime).toBe(slot.endTime);
    });

    it("preserves extra slot fields", () => {
      const result = normalizeSlotTimes(slot, "America/New_York");
      expect(result.id).toBe("slot-1");
      expect(result.professional).toBe("Dr. Smith");
    });

    it("normalizes to UTC", () => {
      const result = normalizeSlotTimes(slot, "UTC");
      expect(result.startTimeLocal).toBe("2026-06-10T14:00:00+00:00");
      expect(result.endTimeLocal).toBe("2026-06-10T15:00:00+00:00");
    });

    it("normalizes to America/New_York (EDT in June)", () => {
      const result = normalizeSlotTimes(slot, "America/New_York");
      expect(result.startTimeLocal).toBe("2026-06-10T10:00:00-04:00");
      expect(result.endTimeLocal).toBe("2026-06-10T11:00:00-04:00");
    });
  });

  describe("normalizeSlots", () => {
    it("normalizes an array of slots", () => {
      const slots = [
        {
          id: "1",
          professional: "A",
          startTime: Date.UTC(2026, 0, 1, 10, 0, 0),
          endTime: Date.UTC(2026, 0, 1, 11, 0, 0),
        },
        {
          id: "2",
          professional: "B",
          startTime: Date.UTC(2026, 0, 1, 12, 0, 0),
          endTime: Date.UTC(2026, 0, 1, 13, 0, 0),
        },
      ];

      const result = normalizeSlots(slots, "Europe/London");
      expect(result).toHaveLength(2);
      expect(result[0].timezone).toBe("Europe/London");
      expect(result[1].timezone).toBe("Europe/London");
    });

    it("returns empty array for empty input", () => {
      expect(normalizeSlots([], "UTC")).toEqual([]);
    });
  });
});
