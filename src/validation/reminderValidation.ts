/**
 * Reminder Schedule Validation
 *
 * Pure validation and normalization utilities for reminder scheduling inputs.
 * All exported functions are side-effect-free and safe to call in tests.
 *
 * Security contract: error strings reference field names and constraint
 * descriptions only — they never echo raw input values back to the caller.
 */

/** Default IANA timezone applied when the caller supplies none. */
export const DEFAULT_REMINDER_TIMEZONE = "UTC";

/**
 * Minimum lead time before a reminder may be scheduled: 60 seconds.
 * Prevents reminders that would fire almost immediately after creation.
 */
export const MIN_SCHEDULE_LEAD_TIME_MS = 60_000;

/**
 * Maximum scheduling look-ahead window: 1 year.
 * Guards against obviously wrong timestamps caused by integer overflow or
 * accidental unit mismatch (e.g. seconds passed instead of milliseconds).
 */
export const MAX_SCHEDULE_LOOK_AHEAD_MS = 365 * 24 * 60 * 60 * 1_000;

/** Structured result returned by {@link validateReminderScheduleInput}. */
export interface ReminderScheduleValidationResult {
  /** Whether all inputs passed validation. */
  valid: boolean;
  /**
   * Human-readable reasons for failure.
   * Never contains raw input values to avoid leaking caller-supplied data.
   */
  errors: string[];
  /** UTC epoch milliseconds; present only when {@link valid} is true. */
  normalizedStartTime?: number;
  /** Resolved IANA timezone; falls back to UTC when none was supplied. */
  resolvedTimezone: string;
}

/**
 * Returns true when `tz` is a recognised IANA timezone identifier.
 *
 * Validation is delegated to the platform's `Intl.DateTimeFormat`, which
 * throws a `RangeError` for unknown identifiers. No third-party library is
 * required.
 *
 * @param tz - Candidate timezone string.
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
 * Returns the UTC offset in whole minutes for an IANA timezone at a specific
 * UTC instant. A positive value means local time is ahead of UTC.
 *
 * Uses `Intl.DateTimeFormat.formatToParts` (available since Node 12+).
 */
function getUTCOffsetMinutes(utcMs: number, timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const tzPart = parts.find((p) => p.type === "timeZoneName");
  if (!tzPart) return 0;

  // Handles "GMT+5:30", "GMT-4", "GMT+10", bare "GMT"
  const match = tzPart.value.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return 0;

  const sign = match[1] === "+" ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const mins = parseInt(match[3] ?? "0", 10);
  return sign * (hours * 60 + mins);
}

/**
 * Returns true when the given UTC instant falls within a DST transition window
 * for the supplied IANA timezone.
 *
 * Detection strategy: compare the UTC offset one hour before and one hour
 * after the supplied instant. A change in offset signals a clock transition.
 *
 * This is useful for callers who need to warn about ambiguous or non-existent
 * wall-clock times near spring-forward / fall-back boundaries.
 *
 * @param utcMs    - UTC epoch milliseconds to inspect.
 * @param timezone - Valid IANA timezone identifier.
 */
export function isInDSTTransition(utcMs: number, timezone: string): boolean {
  const hourMs = 3_600_000;
  const offsetBefore = getUTCOffsetMinutes(utcMs - hourMs, timezone);
  const offsetAfter = getUTCOffsetMinutes(utcMs + hourMs, timezone);
  return offsetBefore !== offsetAfter;
}

function checkSlotId(slotId: unknown): string[] {
  if (typeof slotId !== "number" || !Number.isInteger(slotId) || slotId <= 0) {
    return ["slotId must be a positive integer"];
  }
  return [];
}

function checkStartTime(startTime: unknown, nowMs: number): string[] {
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) {
    return ["startTime must be a finite number (epoch milliseconds)"];
  }

  if (!Number.isInteger(startTime)) {
    return ["startTime must be an integer (epoch milliseconds)"];
  }

  const lead = startTime - nowMs;

  if (lead < MIN_SCHEDULE_LEAD_TIME_MS) {
    return [
      `startTime must be at least ${MIN_SCHEDULE_LEAD_TIME_MS / 1_000} seconds in the future`,
    ];
  }

  if (lead > MAX_SCHEDULE_LOOK_AHEAD_MS) {
    return ["startTime must not be more than 1 year in the future"];
  }

  return [];
}

function checkTimezone(timezone: unknown): string[] {
  if (timezone === undefined || timezone === null) return [];

  if (typeof timezone !== "string" || timezone.trim().length === 0) {
    return ["timezone must be a non-empty string when provided"];
  }

  if (!isValidIANATimezone(timezone)) {
    return [
      "timezone must be a valid IANA timezone identifier (e.g. America/New_York, Europe/London)",
    ];
  }

  return [];
}

/**
 * Full validation of all inputs for a reminder scheduling call.
 *
 * Intended for use by API route handlers **before** calling the service layer.
 * Enforces business rules such as minimum lead time and maximum look-ahead
 * that the service itself does not duplicate, keeping the service focused on
 * storage concerns.
 *
 * All constraint violations are collected in a single pass so callers receive
 * a complete list of problems rather than one error at a time.
 *
 * @param slotId    - Slot identifier (must be a positive integer).
 * @param startTime - UTC epoch milliseconds for the slot start.
 * @param timezone  - Optional IANA timezone; defaults to UTC when omitted.
 * @param nowMs     - Injectable "current time" for deterministic unit tests.
 */
export function validateReminderScheduleInput(
  slotId: unknown,
  startTime: unknown,
  timezone?: unknown,
  nowMs: number = Date.now(),
): ReminderScheduleValidationResult {
  const errors = [
    ...checkSlotId(slotId),
    ...checkStartTime(startTime, nowMs),
    ...checkTimezone(timezone),
  ];

  if (errors.length > 0) {
    return { valid: false, errors, resolvedTimezone: DEFAULT_REMINDER_TIMEZONE };
  }

  const resolvedTimezone =
    typeof timezone === "string" && timezone.trim().length > 0
      ? timezone.trim()
      : DEFAULT_REMINDER_TIMEZONE;

  return {
    valid: true,
    errors: [],
    normalizedStartTime: startTime as number,
    resolvedTimezone,
  };
}
