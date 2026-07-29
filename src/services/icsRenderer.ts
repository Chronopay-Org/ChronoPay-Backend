import { randomUUID } from "node:crypto";
import type { MultiLegBooking, MultiLegBookingLeg } from "./schedulingService.js";

/**
 * Options for rendering an ICS attachment for a single leg of a multi-leg booking.
 */
export interface IcsRenderOptions {
  /** Booking that owns the leg. */
  booking: MultiLegBooking;
  /** The specific leg to render. */
  leg: MultiLegBookingLeg;
  /** Whether the leg has been canceled (produces METHOD:CANCEL). */
  canceled?: boolean;
  /** IANA timezone identifier, e.g. "America/New_York". Defaults to "UTC". */
  tzid?: string;
  /** Display name for the organizer (e.g. booker email or business name). */
  organizerName?: string;
  /** Email or URI for the organizer. */
  organizerEmail?: string;
  /** A short description shown in the calendar event. */
  description?: string;
}

/**
 * Format a Date as an iCalendar local-date-time string without separators.
 * e.g. 20260701T120000
 */
function formatIcsDateTime(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  const h = date.getUTCHours().toString().padStart(2, "0");
  const min = date.getUTCMinutes().toString().padStart(2, "0");
  const s = date.getUTCSeconds().toString().padStart(2, "0");
  return `${y}${m}${d}T${h}${min}${s}`;
}

/**
 * Format a Date as an iCalendar DATE value (for all-day events).
 * e.g. 20260701
 */
function formatIcsDate(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${d}`;
}

/**
 * Fold long ICS lines per RFC 5545 (max 75 octets per line, continuation with
 * leading space).
 */
function foldLine(line: string): string {
  const maxLen = 75;
  if (line.length <= maxLen) return line;

  const parts: string[] = [];
  parts.push(line.slice(0, maxLen));
  let remaining = line.slice(maxLen);
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, maxLen - 1);
    parts.push(" " + chunk);
    remaining = remaining.slice(maxLen - 1);
  }
  return parts.join("\r\n");
}

/**
 * Escape text per RFC 5545 (commas, semicolons, backslashes, newlines).
 */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

/**
 * Detect whether a time range (start–end epoch ms) represents an all-day event
 * (i.e. starting and ending exactly on midnight boundaries in the target
 * timezone).  Because we do not have full timezone database resolution at this
 * layer, we use UTC midnight as a reasonable heuristic.  When the caller
 * explicitly wants all-day semantics they should pass `isAllDay: true`.
 */
function isAllDayRange(startMs: number, endMs: number): boolean {
  const start = new Date(startMs);
  const end = new Date(endMs);
  return (
    start.getUTCHours() === 0 &&
    start.getUTCMinutes() === 0 &&
    start.getUTCSeconds() === 0 &&
    end.getUTCHours() === 0 &&
    end.getUTCMinutes() === 0 &&
    end.getUTCSeconds() === 0 &&
    endMs - startMs >= 86_400_000 &&
    endMs - startMs < 172_800_000
  );
}

/**
 * Render a single-leg iCalendar (RFC 5545) attachment string for a booking leg.
 *
 * Each leg receives its own UID.  The generated VEVENT includes:
 * - `X-BOOKING-ID` — the parent booking identifier
 * - `X-LEG-ID` — the leg identifier
 * - `TZID` parameter on DTSTART/DTEND (when `tzid` is provided)
 * - `ORGANIZER` with optional CN and mailto
 * - `METHOD:PUBLISH` for normal legs, `METHOD:CANCEL` for canceled legs
 * - `STATUS:CANCELLED` for canceled legs
 */
export function renderLegIcs(options: IcsRenderOptions): string {
  const { booking, leg, canceled = false, tzid, organizerName, organizerEmail, description } = options;

  const uid = `${leg.legId}-${randomUUID()}@chronopay`;
  const now = new Date();
  const isAllDay = isAllDayRange(leg.startTime, leg.endTime);

  const dtStartDate = new Date(leg.startTime);
  const dtEndDate = new Date(leg.endTime);

  const method = canceled ? "CANCEL" : "PUBLISH";
  const status = canceled ? "CANCELLED" : "CONFIRMED";

  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//Chronopay//MultiLeg ICS//EN");
  lines.push(`METHOD:${method}`);
  lines.push("CALSCALE:GREGORIAN");
  lines.push("BEGIN:VEVENT");
  lines.push(`UID:${uid}`);
  lines.push(`DTSTAMP:${formatIcsDateTime(now)}Z`);

  if (isAllDay) {
    // For all-day events, DTEND is exclusive — use the day after end.
    const dtEndAllDay = new Date(dtEndDate.getTime() + 86_400_000);
    lines.push(`DTSTART;VALUE=DATE:${formatIcsDate(dtStartDate)}`);
    lines.push(`DTEND;VALUE=DATE:${formatIcsDate(dtEndAllDay)}`);
  } else {
    const tzParam = tzid ? `;TZID=${tzid}` : "";
    lines.push(`DTSTART${tzParam}:${formatIcsDateTime(dtStartDate)}`);
    lines.push(`DTEND${tzParam}:${formatIcsDateTime(dtEndDate)}`);
  }

  if (!isAllDay && !tzid) {
    // Append UTC suffix when no TZID is specified
    const idxStart = lines.length - 2;
    const idxEnd = lines.length - 1;
    lines[idxStart] = lines[idxStart].endsWith("Z") ? lines[idxStart] : lines[idxStart] + "Z";
    lines[idxEnd] = lines[idxEnd].endsWith("Z") ? lines[idxEnd] : lines[idxEnd] + "Z";
  }

  lines.push(`STATUS:${status}`);

  if (organizerEmail) {
    const cn = organizerName ? `;CN=${escapeIcsText(organizerName)}` : "";
    lines.push(`ORGANIZER${cn}:mailto:${organizerEmail}`);
  }

  const summary = canceled
    ? `Canceled: Booking ${booking.bookingId} — Leg ${leg.legId}`
    : `Booking ${booking.bookingId} — Leg ${leg.legId}`;
  lines.push(`SUMMARY:${escapeIcsText(summary)}`);

  if (description) {
    lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  }

  // Linking properties
  lines.push(`X-BOOKING-ID:${booking.bookingId}`);
  lines.push(`X-LEG-ID:${leg.legId}`);

  if (leg.professional) {
    lines.push(`X-PROFESSIONAL:${escapeIcsText(leg.professional)}`);
  }

  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/**
 * Render ICS attachments for every leg in a multi-leg booking.
 *
 * Returns an array of `{ legId, icsContent }` — one entry per leg.  Callers
 * can attach each to the corresponding email or bundle them together.
 */
export function renderAllLegsIcs(
  booking: MultiLegBooking,
  overrides?: Partial<Omit<IcsRenderOptions, "booking" | "leg">> & {
    /** Specific legs to exclude (by legId). */
    excludeLegIds?: string[];
  },
): { legId: string; icsContent: string }[] {
  const exclude = new Set(overrides?.excludeLegIds ?? []);
  return booking.legs
    .filter((leg) => !exclude.has(leg.legId))
    .map((leg) => ({
      legId: leg.legId,
      icsContent: renderLegIcs({
        booking,
        leg,
        canceled: false,
        tzid: overrides?.tzid,
        organizerName: overrides?.organizerName,
        organizerEmail: overrides?.organizerEmail,
        description: overrides?.description,
      }),
    }));
}
