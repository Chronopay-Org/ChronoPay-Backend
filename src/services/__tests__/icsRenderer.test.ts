import { describe, it, expect } from "@jest/globals";
import { renderLegIcs, renderAllLegsIcs } from "../icsRenderer.js";
import type {} from "../schedulingService.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TIME = 1_900_000_000_000; // 2030-03-20T12:26:40.000Z — a known UTC instant

function utcMs(y: number, m: number, d: number, h = 0, min = 0, s = 0): number {
  return Date.UTC(y, m - 1, d, h, min, s);
}

function makeLeg(overrides: Partial<MultiBookingLegLeg> & { startTime: number; endTime: number }): MultiBookingLegLeg {
  return {
    legId: "leg-1",
    slotId: "slot-1",
    professional: "Dr. Smith",
    offsetMs: 0,
    ...overrides,
  };
}

// Re-declare locally to avoid import issues
interface LegFields {
  legId: string;
  slotId: string;
  professional: string;
  startTime: number;
  endTime: number;
  offsetMs?: number;
}

function makeBooking(overrides?: Partial<MultiBookingBooking> & { legs?: LegFields[] }): MultiBookingBooking {
  return {
    bookingId: "booking-abc-123",
    buyerId: "buyer-456",
    legs: overrides?.legs ?? [
      makeLeg({ legId: "leg-1", startTime: BASE_TIME, endTime: BASE_TIME + 3_600_000 }),
      makeLeg({ legId: "leg-2", startTime: BASE_TIME + 7_200_000, endTime: BASE_TIME + 10_800_000 }),
    ],
    ...overrides,
  };
}

interface MultiBookingBooking {
  bookingId: string;
  buyerId: string;
  tenantId?: string;
  legs: LegFields[];
  sagaId?: string;
}

interface MultiBookingLegLeg {
  legId: string;
  slotId: string;
  professional: string;
  startTime: number;
  endTime: number;
  offsetMs?: number;
}

// ---------------------------------------------------------------------------
// ICS parsing helpers for test assertions
// ---------------------------------------------------------------------------

function _parseIcsProperties(ics: string): Map<string, string> {
  const props = new Map<string, string>();
  // Unfold lines first
  const unfolded = ics.replace(/\r\n /g, "");
  for (const line of unfolded.split("\r\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const name = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    props.set(name, value);
  }
  return props;
}

function getIcsProperty(ics: string, name: string): string | undefined {
  const unfolded = ics.replace(/\r\n /g, "");
  const regex = new RegExp(`^${name}((?:;[^:]*)*):(.+)$`, "m");
  const match = unfolded.match(regex);
  return match?.[2];
}

function getIcsRawLine(ics: string, name: string): string | undefined {
  const unfolded = ics.replace(/\r\n /g, "");
  const regex = new RegExp(`^${name}((?:;[^:]*)*):(.+)$`, "m");
  const match = unfolded.match(regex);
  if (!match) return undefined;
  // Return the full property line without unfolding artifacts
  return `${name}${match[1]}:${match[2]}`;
}

function _countLines(ics: string): number {
  return ics.trim().split(/\r?\n/).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderLegIcs", () => {
  it("produces a valid VCALENDAR envelope", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({ booking, leg });

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:-//Chronopay//MultiLeg ICS//EN");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
  });

  it("contains METHOD:PUBLISH for a normal leg", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({ booking, leg });
    expect(ics).toContain("METHOD:PUBLISH");
  });

  it("contains METHOD:CANCEL and STATUS:CANCELLED for a canceled leg", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({ booking, leg, canceled: true });

    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).not.toContain("METHOD:PUBLISH");
    expect(ics).not.toContain("STATUS:CONFIRMED");
    expect(ics).toContain("Canceled: Booking booking-abc-123 — Leg leg-1");
  });

  it("generates a unique UID per leg", () => {
    const booking = makeBooking();
    const ics1 = renderLegIcs({ booking, leg: booking.legs[0] });
    const ics2 = renderLegIcs({ booking, leg: booking.legs[1] });

    const uid1 = getIcsProperty(ics1, "UID");
    const uid2 = getIcsProperty(ics2, "UID");
    expect(uid1).toBeDefined();
    expect(uid2).toBeDefined();
    expect(uid1).not.toBe(uid2);
  });

  it("UID includes the leg id and chronopay domain", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({ booking, leg });
    const uid = getIcsProperty(ics, "UID");
    expect(uid).toContain("leg-1-");
    expect(uid).toMatch(/@chronopay$/);
  });

  it("includes DTSTART and DTEND with UTC 'Z' suffix when no TZID", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({ booking, leg });

    const dtStart = getIcsProperty(ics, "DTSTART");
    const dtEnd = getIcsProperty(ics, "DTEND");
    expect(dtStart).toMatch(/^\d{8}T\d{6}Z$/);
    expect(dtEnd).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("includes TZID parameter on DTSTART and DTEND when tzid provided", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({ booking, leg, tzid: "America/New_York" });

    const dtStartRaw = getIcsRawLine(ics, "DTSTART");
    const dtEndRaw = getIcsRawLine(ics, "DTEND");
    expect(dtStartRaw).toMatch(/^DTSTART;TZID=America\/New_York:/);
    expect(dtEndRaw).toMatch(/^DTEND;TZID=America\/New_York:/);
  });

  it("renders all-day legs with VALUE=DATE (no time component)", () => {
    // All-day: start at midnight UTC, duration exactly 24h
    const start = utcMs(2026, 7, 15, 0, 0, 0);
    const end = utcMs(2026, 7, 16, 0, 0, 0);
    const booking = makeBooking({
      legs: [makeLeg({ legId: "leg-all-day", startTime: start, endTime: end })],
    });
    const ics = renderLegIcs({ booking, leg: booking.legs[0] });

    const dtStartRaw = getIcsRawLine(ics, "DTSTART");
    const dtEndRaw = getIcsRawLine(ics, "DTEND");
    expect(dtStartRaw).toBe("DTSTART;VALUE=DATE:20260715");
    expect(dtEndRaw).toBe("DTEND;VALUE=DATE:20260717");
  });

  it("renders cross-day legs with DTSTART/DTEND in datetime form", () => {
    // Cross-day: start at 10pm UTC, end at 2am UTC next day
    const start = utcMs(2026, 7, 15, 22, 0, 0);
    const end = utcMs(2026, 7, 16, 2, 0, 0);
    const booking = makeBooking({
      legs: [makeLeg({ legId: "leg-cross-day", startTime: start, endTime: end })],
    });
    const ics = renderLegIcs({ booking, leg: booking.legs[0] });

    const dtStartRaw = getIcsRawLine(ics, "DTSTART");
    const dtStart = getIcsProperty(ics, "DTSTART");
    const dtEnd = getIcsProperty(ics, "DTEND");
    // Should be in datetime form, not VALUE=DATE
    expect(dtStartRaw).not.toContain("VALUE=DATE");
    expect(dtStart).toMatch(/^\d{8}T\d{6}Z$/);
    expect(dtEnd).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("includes ORGANIZER with CN and mailto when provided", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({
      booking,
      leg,
      organizerName: "Alice Buyer",
      organizerEmail: "alice@example.com",
    });

    const organizerRaw = getIcsRawLine(ics, "ORGANIZER");
    expect(organizerRaw).toMatch(/^ORGANIZER;CN=Alice Buyer:/);
    expect(organizerRaw).toContain("mailto:alice@example.com");
  });

  it("skips ORGANIZER when email is omitted", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({ booking, leg, organizerName: "Nobody" });
    expect(ics).not.toContain("ORGANIZER");
  });

  it("includes X-BOOKING-ID and X-LEG-ID linking properties", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({ booking, leg });

    expect(getIcsProperty(ics, "X-BOOKING-ID")).toBe("booking-abc-123");
    expect(getIcsProperty(ics, "X-LEG-ID")).toBe("leg-1");
  });

  it("includes X-PROFESSIONAL property", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({ booking, leg });

    expect(getIcsProperty(ics, "X-PROFESSIONAL")).toBe("Dr. Smith");
  });

  it("includes DESCRIPTION when provided", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({
      booking,
      leg,
      description: "Please arrive 15 minutes early",
    });

    expect(getIcsProperty(ics, "DESCRIPTION")).toBe("Please arrive 15 minutes early");
  });

  it("SUMMARY contains booking id and leg id", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({ booking, leg });

    expect(getIcsProperty(ics, "SUMMARY")).toBe("Booking booking-abc-123 — Leg leg-1");
  });

  it("DTSTAMP is present and valid", () => {
    const booking = makeBooking();
    const leg = booking.legs[0];
    const ics = renderLegIcs({ booking, leg });

    const dtStamp = getIcsProperty(ics, "DTSTAMP");
    expect(dtStamp).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("lines are folded at 75 octets per RFC 5545", () => {
    // Generate a leg that will produce a long line (e.g. long UUID in UID)
    const booking = makeBooking({
      legs: [makeLeg({ legId: "x".repeat(60), startTime: BASE_TIME, endTime: BASE_TIME + 3_600_000 })],
    });
    const ics = renderLegIcs({ booking, leg: booking.legs[0] });

    // Check that no line (before unfolding) exceeds 75 octets
    for (const rawLine of ics.split("\r\n")) {
      // Continuation lines start with space — check only the start of folded sequences
      if (!rawLine.startsWith(" ") && rawLine.length > 0) {
        // Unfolded content still shouldn't have raw line exceeding 75
        // Actually folded means first line <= 75, continuation lines <= 75
        expect(rawLine.length).toBeLessThanOrEqual(75);
      }
    }
  });

  it("escapes special characters in text values", () => {
    const booking = makeBooking({
      legs: [
        makeLeg({
          legId: "leg-x",
          professional: "Smith, Jr. & Co.",
          startTime: BASE_TIME,
          endTime: BASE_TIME + 3_600_000,
        }),
      ],
    });
    const ics = renderLegIcs({
      booking,
      leg: booking.legs[0],
      description: "Note: bring ID; arrive early\nThanks!",
    });

    const summary = getIcsProperty(ics, "SUMMARY") ?? "";
    expect(summary).not.toContain(",");
    expect(summary).not.toContain(";");

    const xprof = getIcsProperty(ics, "X-PROFESSIONAL") ?? "";
    // Comma is escaped as \, so the raw string contains backslash followed by comma
    expect(xprof).toContain("\\,");
    // No unescaped comma (comma not preceded by backslash)
    expect(xprof).not.toMatch(/(?<!\\),/);

    const desc = getIcsProperty(ics, "DESCRIPTION") ?? "";
    // Semicolons and newlines are escaped
    expect(desc).toContain("\\;");
    expect(desc).toContain("\\n");
    // No unescaped standalone semicolons
    expect(desc).not.toMatch(/(?<!\\);/);
  });
});

describe("renderAllLegsIcs", () => {
  it("returns one entry per leg", () => {
    const booking = makeBooking();
    const results = renderAllLegsIcs(booking);

    expect(results).toHaveLength(2);
    expect(results[0].legId).toBe("leg-1");
    expect(results[1].legId).toBe("leg-2");
    expect(results[0].icsContent).toBeTruthy();
    expect(results[1].icsContent).toBeTruthy();
  });

  it("each entry has valid ICS content", () => {
    const booking = makeBooking();
    const results = renderAllLegsIcs(booking);

    for (const { icsContent } of results) {
      expect(icsContent).toContain("BEGIN:VCALENDAR");
      expect(icsContent).toContain("END:VCALENDAR");
      expect(icsContent).toContain("METHOD:PUBLISH");
    }
  });

  it("unique UIDs across legs in the same booking", () => {
    const booking = makeBooking();
    const results = renderAllLegsIcs(booking);

    const uids = results.map((r) => getIcsProperty(r.icsContent, "UID"));
    expect(new Set(uids).size).toBe(2);
  });

  it("excludes legs specified in excludeLegIds", () => {
    const booking = makeBooking();
    const results = renderAllLegsIcs(booking, { excludeLegIds: ["leg-1"] });

    expect(results).toHaveLength(1);
    expect(results[0].legId).toBe("leg-2");
  });

  it("forwards tzid to all legs", () => {
    const booking = makeBooking();
    const results = renderAllLegsIcs(booking, { tzid: "Europe/London" });

    for (const { icsContent } of results) {
      expect(icsContent).toContain("DTSTART;TZID=Europe/London");
    }
  });
});
