import type { AuthContext } from "../../middleware/auth.js";
import type { SlotRepository } from "../slots/slot-repository.js";
import type {
  BookingIntentRecord,
  BookingIntentRepository,
} from "./booking-intent-repository.js";

export interface CreateBookingIntentInput {
  slotId: string;
  note?: string;
}

export class BookingIntentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BookingIntentError";
  }
}

export class BookingIntentService {
  constructor(
    private readonly bookingIntentRepository: BookingIntentRepository,
    private readonly slotRepository: SlotRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  createIntent(input: CreateBookingIntentInput, actor: AuthContext): BookingIntentRecord {
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

    const existingForCustomer = this.bookingIntentRepository.findBySlotIdAndCustomer(
      input.slotId,
      actor.userId,
    );
    if (existingForCustomer) {
      throw new BookingIntentError(409, "A booking intent already exists for this slot.");
    }

    const existingForSlot = this.bookingIntentRepository.findBySlotId(input.slotId);
    if (existingForSlot) {
      throw new BookingIntentError(409, "Selected slot already has an active booking intent.");
    }

    return this.bookingIntentRepository.create({
      slotId: slot.id,
      professional: slot.professional,
      customerId: actor.userId,
      startTime: slot.startTime,
      endTime: slot.endTime,
      status: "pending",
      note: input.note,
      createdAt: this.now(),
    });
  }
}

export function parseCreateBookingIntentBody(body: unknown): CreateBookingIntentInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BookingIntentError(400, "Booking intent payload must be a JSON object.");
  }

  const { slotId, note } = body as { slotId?: unknown; note?: unknown };

  if (typeof slotId !== "string" || slotId.trim().length === 0) {
    throw new BookingIntentError(400, "slotId is required.");
  }

  const normalizedSlotId = slotId.trim();
  if (!/^[a-zA-Z0-9-]{3,64}$/.test(normalizedSlotId)) {
    throw new BookingIntentError(400, "slotId format is invalid.");
  }

  if (note === undefined) {
    return { slotId: normalizedSlotId };
  }

  if (typeof note !== "string") {
    throw new BookingIntentError(400, "note must be a string when provided.");
  }

  const normalizedNote = note.trim();
  if (normalizedNote.length === 0) {
    throw new BookingIntentError(400, "note cannot be empty when provided.");
  }

  if (normalizedNote.length > 500) {
    throw new BookingIntentError(400, "note must be 500 characters or fewer.");
  }

  return {
    slotId: normalizedSlotId,
    note: normalizedNote,
  };
}
