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
 * Schema for POST /api/v1/booking-intents body.
 *
 * Fields:
 *   - slotId  string matching slot-<uuid> pattern
 *   - note    optional string, max 500 chars
 *
 * Unknown fields are stripped.
 */
export const CreateBookingIntentBodySchema = z
  .object({
    slotId: z
      .string()
      .min(1, { message: "slotId is required" })
      .regex(SLOT_ID_PATTERN, { message: "slotId format is invalid" }),
    note: z
      .string()
      .min(1, { message: "note cannot be empty when provided" })
      .max(500, { message: "note must be 500 characters or fewer" })
      .optional(),
  })
  .strip();

export type CreateBookingIntentBody = z.infer<typeof CreateBookingIntentBodySchema>;
