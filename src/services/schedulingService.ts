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

export class SlotExpiredError extends Error {
  constructor(slotId: string, validUntil: number) {
    super(`Slot ${slotId} bundle has expired (valid until ${new Date(validUntil).toISOString()})`);
    this.name = "SlotExpiredError";
    this.slotId = slotId;
    this.validUntil = validUntil;
  }

  readonly slotId: string;
  readonly validUntil: number;
}

export class EscrowPausedError extends Error {
  constructor() {
    super(`Escrow contract migration in progress: new holds are temporarily paused`);
    this.name = "EscrowPausedError";
  }
}

import { escrowMigrationState } from "./escrowMigrationState.js";

/**
 * Coordinates slot reservation with booking intent state transitions.
 *
 * On intent creation   -> slot is marked not bookable (reserved).
 * On cancel / expire   -> slot is marked bookable (freed).
 *
 * When a slot carries a validUntil deadline the reservation is rejected
 * once the current time exceeds the window, returning SlotExpiredError.
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

  reserveSlot(slotId: string, now?: number): void {
    if (escrowMigrationState.isPaused()) {
      throw new EscrowPausedError();
    }
    const slot = this.slotRepository.findById(slotId);
    if (!slot) {
      throw new SlotNotFoundError(slotId);
    }
    if (!slot.bookable) {
      throw new SlotNotBookableError(slotId);
    }
    if (slot.validUntil !== undefined && slot.validUntil !== null) {
      const currentTime = now ?? Date.now();
      if (currentTime >= slot.validUntil) {
        throw new SlotExpiredError(slotId, slot.validUntil);
      }
    }
    this.slotRepository.updateBookable(slotId, false);
  }

  releaseSlot(slotId: string): void {
    this.slotRepository.updateBookable(slotId, true);
  }
}
