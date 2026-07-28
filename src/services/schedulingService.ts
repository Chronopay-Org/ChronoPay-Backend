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

export class TenantPausedError extends Error {
  constructor(tenantId: string) {
    super(`Tenant ${tenantId} is paused`);
    this.name = "TenantPausedError";
  }
}

export class BundleReservationError extends Error {
  constructor(bundleId: string, cause: Error) {
    super(`Failed to reserve bundle ${bundleId}: ${cause.message}`);
    this.name = "BundleReservationError";
    this.cause = cause;
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
  public pausedTenants: Set<string> = new Set();
  private reservedBundles: Map<string, Set<string>> = new Map();

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

  reserveBundle(bundleId: string, slotIds: string[], tenantId?: string): void {
    if (tenantId && this.pausedTenants.has(tenantId)) {
      throw new TenantPausedError(tenantId);
    }

    if (this.reservedBundles.has(bundleId)) {
      throw new Error(`Bundle ${bundleId} is already reserved`);
    }

    const uniqueSlotIds = Array.from(new Set(slotIds));
    const reserved: string[] = [];

    try {
      for (const slotId of uniqueSlotIds) {
        this.reserveSlot(slotId);
        reserved.push(slotId);
      }
      this.reservedBundles.set(bundleId, new Set(uniqueSlotIds));
    } catch (error) {
      // Rollback
      for (const slotId of reserved) {
        this.releaseSlot(slotId);
      }
      throw new BundleReservationError(bundleId, error as Error);
    }
  }

  releaseBundle(bundleId: string): void {
    const slots = this.reservedBundles.get(bundleId);
    if (!slots) {
      throw new Error(`Bundle ${bundleId} not found`);
    }
    for (const slotId of slots) {
      this.releaseSlot(slotId);
    }
    this.reservedBundles.delete(bundleId);
  }
}
