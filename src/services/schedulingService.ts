import type { BookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import type { SlotRepository } from "../modules/slots/slot-repository.js";

export class SlotNotBookableError extends Error {
  constructor(slotId: string) {
    super(`Slot ${slotId} is not bookable`);
    this.name = "SlotNotBookableError";
  }
}

export class SlotNotFoundError extends Error {
  constructor(slotId: string) {
    super(`Slot ${slotId} not found`);
    this.name = "SlotNotFoundError";
  }
}

/**
 * Coordinates slot reservation with booking intent state transitions.
 *
 * On intent creation   -> slot is marked not bookable (reserved).
 * On cancel / expire   -> slot is marked bookable (freed).
 *
 * In a production DB these operations would be wrapped in a single
 * transaction so the slot update and intent update commit or roll back
 * together.
 */
export class SchedulingService {
  constructor(
    private readonly slotRepository: SlotRepository,
    private readonly bookingIntentRepository: BookingIntentRepository,
  ) {}

  reserveSlot(slotId: string): void {
    const slot = this.slotRepository.findById(slotId);
    if (!slot) {
      throw new SlotNotFoundError(slotId);
    }
    if (!slot.bookable) {
      throw new SlotNotBookableError(slotId);
    }
    this.slotRepository.updateBookable(slotId, false);
  }

  releaseSlot(slotId: string): void {
    this.slotRepository.updateBookable(slotId, true);
  }
}
