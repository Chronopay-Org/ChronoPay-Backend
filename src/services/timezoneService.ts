/**
 * Timezone Service
 *
 * Pure, side-effect-free utilities for resolving and normalizing timezones
 * in the slot availability flow. Designed for easy unit testing with no
 * external dependencies.
 *
 * Resolution precedence:
 *   1. Buyer profile timezone (stored IANA tz)
 *   2. X-Timezone request header (IANA tz from client)
 *   3. UTC fallback
 *
 * Security: malformed timezone strings are rejected early; raw input is
 * never echoed back in error messages.
 */

export const DEFAULT_TIMEZONE = "UTC";

/**
 * Validates that a string is a recognised IANA timezone identifier.
 * Delegates to the platform's `Intl.DateTimeFormat`, which throws
 * `RangeError` for unknown identifiers.
 */
export function isValidIANATimezone(tz: string): boolean {
  if (typeof tz !== "string" || tz.trim().length === 0) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the buyer's display timezone from profile and header values.
 *
 * Precedence:
 *   1. Profile timezone (if valid IANA)
 *   2. Header timezone (if valid IANA)
 *   3. UTC fallback
 *
 * @param profileTimezone - Timezone from buyer profile (nullable/undefined if no profile or no tz field).
 * @param headerTimezone  - Timezone from X-Timezone request header (nullable/undefined if absent).
 * @returns A valid IANA timezone string, or UTC if neither source is valid.
 */
export function resolveTimezone(
  profileTimezone?: string | null,
  headerTimezone?: string | null,
): string {
  if (profileTimezone && isValidIANATimezone(profileTimezone)) {
    return profileTimezone;
  }
  if (headerTimezone && isValidIANATimezone(headerTimezone)) {
    return headerTimezone;
  }
  return DEFAULT_TIMEZONE;
}

/**
 * Formats a UTC epoch millisecond timestamp into a locale-aware ISO-8601
 * string with the timezone offset appended.
 *
 * Example: `formatToTimezoneOffset(1700000000000, "America/New_York")`
 * returns `"2023-11-14T19:13:20-05:00"`
 *
 * Returns `null` if the timestamp is not a finite number or the timezone
 * is invalid.
 */
export function formatToTimezoneOffset(utcMs: number, timezone: string): string | null {
  if (!Number.isFinite(utcMs)) return null;
  if (!isValidIANATimezone(timezone)) return null;

  try {
    const date = new Date(utcMs);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "shortOffset",
    }).formatToParts(date);

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");
    const second = get("second");
    const tzName = get("timeZoneName");

    // Parse the offset from the timezone name (e.g. "GMT-5", "GMT+5:30")
    const offsetMatch = tzName.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    let offsetStr = "+00:00";
    if (offsetMatch) {
      const sign = offsetMatch[1];
      const h = offsetMatch[2].padStart(2, "0");
      const m = (offsetMatch[3] ?? "00").padStart(2, "0");
      offsetStr = `${sign}${h}:${m}`;
    }

    // Handle midnight overflow (hour 24 -> 00 next day)
    const hNum = parseInt(hour, 10);
    const displayHour = hNum === 24 ? "00" : hour;

    return `${year}-${month}-${day}T${displayHour}:${minute}:${second}${offsetStr}`;
  } catch {
    return null;
  }
}

/**
 * Normalizes a single slot's times to the buyer's local timezone.
 *
 * Returns a new object with:
 *   - `startTimeLocal`: ISO-8601 string in buyer's TZ with offset
 *   - `endTimeLocal`: ISO-8601 string in buyer's TZ with offset
 *   - Original `startTime` and `endTime` preserved (UTC epoch ms)
 *
 * @param slot     - Slot with numeric startTime/endTime (UTC epoch ms).
 * @param timezone - Resolved IANA timezone.
 */
export function normalizeSlotTimes<T extends { startTime: number; endTime: number }>(
  slot: T,
  timezone: string,
): T & {
  startTimeLocal: string | null;
  endTimeLocal: string | null;
  timezone: string;
} {
  return {
    ...slot,
    startTimeLocal: formatToTimezoneOffset(slot.startTime, timezone),
    endTimeLocal: formatToTimezoneOffset(slot.endTime, timezone),
    timezone,
  };
}

/**
 * Normalizes an array of slots to the buyer's local timezone.
 *
 * Also attaches a top-level `timezone` field on the result object for
 * debugging / client-side cache keying.
 *
 * @param slots    - Array of slots with numeric startTime/endTime.
 * @param timezone - Resolved IANA timezone.
 * @returns Array of normalized slots.
 */
export function normalizeSlots<
  T extends { startTime: number; endTime: number },
>(
  slots: T[],
  timezone: string,
): (T & {
  startTimeLocal: string | null;
  endTimeLocal: string | null;
  timezone: string;
})[] {
  return slots.map((slot) => normalizeSlotTimes(slot, timezone));
}
