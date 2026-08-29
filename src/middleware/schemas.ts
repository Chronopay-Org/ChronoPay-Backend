/**
 * @file src/middleware/schemas.ts
 *
 * Zod schemas for request body validation.
 *
 * Convention: one exported schema per route that needs body validation.
 * Each schema uses `.strip()` semantics (unknown fields are removed).
 *
 * Schema naming: <Resource><Action>BodySchema
 */

import { z } from "zod";
import { SLOT_ID_PATTERN } from "../modules/booking-intents/booking-intent-service.js";
import { sanitizeNote } from "../utils/redact.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Accepts a numeric epoch (ms) or an ISO-8601 date string.
 * Returns the value as-is (number or string) — downstream service handles
 * the actual epoch conversion and range checks.
 */
const epochOrIso = (fieldName: string) =>
  z.union(
    [
      z.number().finite({ message: `${fieldName} must be a finite number` }),
      z
        .string()
        .min(1, { message: `${fieldName} must not be empty` })
        .refine((v) => !isNaN(Date.parse(v)), {
          message: `${fieldName} must be a valid numeric epoch or ISO-8601 date string`,
        }),
    ],
    {
      errorMap: () => ({
        message: `${fieldName} must be a valid numeric epoch or ISO-8601 date string`,
      }),
    },
  );

// ─── Slots ────────────────────────────────────────────────────────────────────

/**
 * Schema for POST /api/v1/slots body.
 *
 * Fields:
 *   - professional  non-empty string
 *   - startTime     numeric epoch (ms) or ISO-8601 string
 *   - endTime       numeric epoch (ms) or ISO-8601 string
 *
 * Unknown fields are stripped.
 */
export const CreateSlotBodySchema = z
  .object({
    professional: z.string().min(1, { message: "professional must be a non-empty string" }),
    startTime: epochOrIso("startTime"),
    endTime: epochOrIso("endTime"),
  })
  .strip();

export type CreateSlotBody = z.infer<typeof CreateSlotBodySchema>;

// ─── Booking Intents ──────────────────────────────────────────────────────────

/**
 * Optional `note` field shared by single and recurring booking intents.
 *
 * The value is sanitized exactly like `parseCreateBookingIntentBody` does:
 * control characters are removed, unicode is NFC-normalized, and the result
 * is trimmed. Sanitized-empty values and values longer than 500 characters
 * are rejected. Untouched values never reach the service.
 *
 * When the field is absent the key stays absent on the parsed output.
 */
const noteField = z
  .string({ invalid_type_error: "note must be a string when provided" })
  .max(500, { message: "note must be 500 characters or fewer" })
  .transform((value): string | null => sanitizeNote(value))
  .refine((value): value is string => value !== null, {
    message: "note cannot be empty when provided",
  })
  .optional();

/**
 * Mirrors the DTSTART ambiguity guard in `parseCreateBookingIntentBody`:
 * an inline DTSTART without an explicit timezone offset ("Z" or TZID=) is
 * ambiguous across DST boundaries and must be rejected.
 */
function rruleHasExplicitOffset(rrule: string): boolean {
  const dtstart = rrule.match(/DTSTART(?:;[^:]*)?:(.*)(?:\n|$)/);
  if (!dtstart) return true;
  return dtstart[1].endsWith("Z") || rrule.includes("TZID=");
}

/**
 * Schema for POST /api/v1/booking-intents body.
 *
 * A booking intent is either:
 *   - single:  `slotId` (required, slot-<uuid> pattern), optional `note`
 *   - recurring: `rrule` (required, DTSTART must carry an explicit offset),
 *                optional `note`
 *
 * Optional fields for both shapes:
 *   - bookingType     "standard" | "refundable_hold"
 *   - holdDeadlineMs  positive-safe integer used by supplier hold policies
 *
 * Exactly one of `slotId` / `rrule` must be provided (when both are present
 * the request is treated as recurring, matching the domain parser).
 * Unknown fields are stripped; values are returned sanitized.
 */
export const CreateBookingIntentBodySchema = z
  .object({
    slotId: z
      .string({ invalid_type_error: "slotId must be a string" })
      .trim()
      .min(1, { message: "slotId is required" })
      .regex(SLOT_ID_PATTERN, { message: "slotId format is invalid" })
      .optional(),
    rrule: z
      .string({ invalid_type_error: "rrule must be a string" })
      .trim()
      .min(1, { message: "rrule must be a non-empty string" })
      .refine(rruleHasExplicitOffset, {
        message: "Ambiguous DTSTART: missing explicit timezone offset (Z or TZID)",
      })
      .optional(),
    note: noteField,
    bookingType: z.enum(["standard", "refundable_hold"]).optional(),
    holdDeadlineMs: z.number().optional(),
  })
  .strip()
  .superRefine((data, ctx) => {
    if (data.slotId === undefined && data.rrule === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["slotId"],
        message: "slotId is required when rrule is not provided",
      });
    }
  });

export type CreateBookingIntentBody = z.infer<typeof CreateBookingIntentBodySchema>;

// ─── Conflict Preview ────────────────────────────────────────────────────────

/**
 * Schema for POST /api/v1/slots/conflicts/preview body.
 *
 * Fields:
 *   - rrule           non-empty RRULE string (must be bounded: COUNT or UNTIL)
 *   - professional    non-empty string identifying the professional
 *   - slotDurationMs  positive finite number (slot duration in milliseconds)
 *   - timezone        optional IANA timezone for DST-ambiguity detection
 *   - horizonDays     optional number 1-365, defaults to 90
 *
 * Unknown fields are stripped.
 */
export const ConflictPreviewBodySchema = z
  .object({
    rrule: z.string().min(1, { message: "rrule must be a non-empty string" }),
    professional: z.string().min(1, { message: "professional must be a non-empty string" }),
    slotDurationMs: z
      .number()
      .finite({ message: "slotDurationMs must be a finite number" })
      .positive({ message: "slotDurationMs must be positive" }),
    timezone: z.string().min(1, { message: "timezone must not be empty" }).optional(),
    horizonDays: z
      .number()
      .finite({ message: "horizonDays must be a finite number" })
      .int({ message: "horizonDays must be an integer" })
      .min(1, { message: "horizonDays must be at least 1" })
      .max(365, { message: "horizonDays must be at most 365" })
      .optional(),
  })
  .strip();

export type ConflictPreviewBody = z.infer<typeof ConflictPreviewBodySchema>;
