import type { AuthContext } from "../../middleware/auth.js";
import type { SlotRepository } from "../slots/slot-repository.js";
import type {
  BookingIntentRecord,
  BookingIntentRepository,
} from "./booking-intent-repository.js";
import { SchedulingService } from "../../services/schedulingService.js";
import { withSpan } from "../../tracing/hooks.js";
import { AppError } from "../../errors/AppError.js";
import { ERROR_CODES } from "../../errors/errorCodes.js";
import { sanitizeNote } from "../../utils/redact.js";

export interface CreateBookingIntentInput {
  slotId: string;
  note?: string;
}

export interface CreateRecurringBookingInput {
  rrule: string;
  note?: string;
}

export class BookingIntentError extends AppError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    const code =
      status === 400
        ? ERROR_CODES.BAD_REQUEST.code
        : status === 403
          ? ERROR_CODES.FORBIDDEN.code
          : status === 404
            ? ERROR_CODES.NOT_FOUND.code
            : status === 409
              ? ERROR_CODES.CONFLICT.code
              : status === 422
                ? ERROR_CODES.UNPROCESSABLE_ENTITY.code
                : ERROR_CODES.INTERNAL_ERROR.code;
    super(message, status, code, true);
    this.name = "BookingIntentError";
  }
}

export class BookingIntentService {
  constructor(
    private readonly bookingIntentRepository: BookingIntentRepository,
    private readonly slotRepository: SlotRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private get schedulingService(): SchedulingService {
    return new SchedulingService(this.slotRepository, this.bookingIntentRepository);
  }

  async createIntent(input: CreateBookingIntentInput, actor: AuthContext): Promise<BookingIntentRecord> {
    const slot = this.slotRepository.findById(input.slotId);
    if (!slot) {
      throw new BookingIntentError(404, "Selected slot was not found.");
    }

    if (!slot.bookable) {
      throw new BookingIntentError(409, "Selected slot is not bookable.");
    }

    if (slot.professional === actor.userId) {
      throw new BookingIntentError(403, "You cannot create a booking intent for your own slot.");
    }

    const existingForCustomer = await this.bookingIntentRepository.findBySlotIdAndCustomer(
      input.slotId,
      actor.userId,
    );
    if (existingForCustomer) {
      throw new BookingIntentError(409, "A booking intent already exists for this slot.");
    }

    const existingForSlot = await this.bookingIntentRepository.findBySlotId(input.slotId);
    if (existingForSlot) {
      throw new BookingIntentError(409, "Selected slot already has an active booking intent.");
    }

    const intent = this.bookingIntentRepository.create({
      slotId: slot.id,
      professional: slot.professional,
      customerId: actor.userId,
      startTime: slot.startTime,
      endTime: slot.endTime,
      status: "pending",
      note: input.note,
      createdAt: this.now(),
    });

    this.schedulingService.reserveSlot(input.slotId);

    return intent;
  }

  async createRecurringIntents(input: CreateRecurringBookingInput, actor: AuthContext): Promise<{ successes: BookingIntentRecord[]; failures: { date: string; reason: string }[] }> {
    const { expandRRule, RecurrenceError } = await import("../../services/recurrenceService.js");

    let occurrences: Date[];
    try {
      occurrences = expandRRule(input.rrule);
    } catch (err) {
      if (err instanceof RecurrenceError) {
        throw new BookingIntentError(400, err.message);
      }
      throw err;
    }

    const successes: BookingIntentRecord[] = [];
    const failures: { date: string; reason: string }[] = [];

    // For each occurrence, attempt to find a matching slot and create intent
    for (const occ of occurrences) {
      const startEpoch = occ.getTime();
      const slot = this.slotRepository.list().find((s) => s.startTime === startEpoch && s.bookable);
      if (!slot) {
        failures.push({ date: occ.toISOString(), reason: "No available slot at this time" });
        continue;
      }

      // Basic conflicts and checks similar to single-create
      if (slot.professional === actor.userId) {
        failures.push({ date: occ.toISOString(), reason: "Cannot book your own slot" });
        continue;
      }

      const existingForCustomer = await this.bookingIntentRepository.findBySlotIdAndCustomer(slot.id, actor.userId);
      if (existingForCustomer) {
        failures.push({ date: occ.toISOString(), reason: "Customer already has an intent for this slot" });
        continue;
      }

      const existingForSlot = await this.bookingIntentRepository.findBySlotId(slot.id);
      if (existingForSlot) {
        failures.push({ date: occ.toISOString(), reason: "Slot already has active booking intent" });
        continue;
      }

      const intent = await this.bookingIntentRepository.create({
        slotId: slot.id,
        professional: slot.professional,
        customerId: actor.userId,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: "pending",
        note: input.note,
        createdAt: this.now(),
      });

      // Reserve slot
      this.schedulingService.reserveSlot(slot.id);

      successes.push(intent);
    }

    return { successes, failures };
  }

  confirmIntent(intentId: string, actor: AuthContext): BookingIntentRecord {
    const intent = this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (intent.customerId !== actor.userId && actor.role !== "admin") {
      throw new BookingIntentError(403, "Only the intent owner or admin can confirm a booking intent.");
    }

    if (intent.status !== "pending") {
      throw new BookingIntentError(409, `Cannot confirm intent with status "${intent.status}".`);
    }

    return this.bookingIntentRepository.updateStatus(intentId, "confirmed");
  }

  cancelIntent(intentId: string, actor: AuthContext): BookingIntentRecord {
    const intent = this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (intent.customerId !== actor.userId && actor.role !== "admin") {
      throw new BookingIntentError(403, "You are not authorized to cancel this booking intent.");
    }

    if (intent.status !== "pending") {
      throw new BookingIntentError(409, `Cannot cancel intent with status "${intent.status}".`);
    }

    const updated = this.bookingIntentRepository.updateStatus(intentId, "cancelled");

    this.schedulingService.releaseSlot(intent.slotId);

    return updated;
  }

  expireIntent(intentId: string): BookingIntentRecord {
    const intent = this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (intent.status !== "pending") {
      throw new BookingIntentError(409, `Cannot expire intent with status "${intent.status}".`);
    }

    const updated = this.bookingIntentRepository.updateStatus(intentId, "expired");

    this.schedulingService.releaseSlot(intent.slotId);

    return updated;
  }

  createIntentTraced(input: CreateBookingIntentInput, actor: AuthContext): Promise<BookingIntentRecord> {
    return withSpan(
      "bookingIntents.create",
      { route: "POST /api/v1/booking-intents" },
      () => this.createIntent(input, actor),
    );
  }
}

export const SLOT_ID_PATTERN = /^slot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCreateBookingIntentBody(body: unknown): CreateBookingIntentInput | CreateRecurringBookingInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BookingIntentError(400, "Booking intent payload must be a JSON object.");
  }

  const { slotId, note, rrule } = body as { slotId?: unknown; note?: unknown; rrule?: unknown };


  // If an RRULE is provided, treat this as a recurring booking request
  if (rrule !== undefined) {
    if (typeof rrule !== "string" || rrule.trim().length === 0) {
      throw new BookingIntentError(400, "rrule must be a non-empty string.");
    }
    const normalizedRRule = rrule.trim();

    if (note === undefined) {
      return { rrule: normalizedRRule };
    }

    if (typeof note !== "string") {
      throw new BookingIntentError(400, "note must be a string when provided.");
    }

    const sanitizedNote = sanitizeNote(note);
    if (sanitizedNote === null) {
      throw new BookingIntentError(400, "note cannot be empty when provided.");
    }

    if (sanitizedNote.length > 500) {
      throw new BookingIntentError(400, "note must be 500 characters or fewer.");
    }

    return { rrule: normalizedRRule, note: sanitizedNote };
  }

  if (typeof slotId !== "string" || slotId.trim().length === 0) {
    throw new BookingIntentError(400, "slotId is required.");
  }

  const normalizedSlotId = slotId.trim();
  if (!SLOT_ID_PATTERN.test(normalizedSlotId)) {
    throw new BookingIntentError(400, "slotId format is invalid.");
  }

  if (typeof note !== "string") {
    throw new BookingIntentError(400, "note must be a string when provided.");
  }

  const sanitizedNote = sanitizeNote(note);
  if (sanitizedNote === null) {
    throw new BookingIntentError(400, "note cannot be empty when provided.");
  }

  if (sanitizedNote.length > 500) {
    throw new BookingIntentError(400, "note must be 500 characters or fewer.");
  }

  return {
    slotId: normalizedSlotId,
    note: sanitizedNote,
  };
}
