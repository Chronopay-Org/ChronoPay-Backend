// @ts-nocheck
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

/**
 * Thrown when a tenant has been administratively paused and any new
 * reservation work (slot or bundle) targeting that tenant must fail fast.
 *
 * Distinct from EscrowPausedError so that operators can distinguish a
 * tenant-level kill-switch from a global escrow migration pause.
 */
export class TenantPausedError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} is paused`);
    this.name = "TenantPausedError";
  }
}

/**
 * Aggregate error thrown if any leg of a bundle reservation fails. The
 * `cause` exposes the underlying error so callers can branch on the
 * specific cause (not bookable, expired, etc.) without losing the bundle
 * context.
 */
export class BundleReservationError extends Error {
  constructor(
    readonly bundleId: string,
    readonly cause: Error,
  ) {
    super(`Failed to reserve bundle ${bundleId}: ${cause.message}`);
    this.name = "BundleReservationError";
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
  public pausedTenants: Set<string> = new Set();
  private reservedBundles: Map<string, Set<string>> = new Map();

  constructor(
    private readonly slotRepository: SlotRepository,
    private readonly bookingIntentRepository: BookingIntentRepository,
  ) {}

  reserveSlot(slotId: string, now?: number, tenantId?: string): void {
    if (escrowMigrationState.isPaused()) {
      throw new EscrowPausedError();
    }
    if (tenantId && this.pausedTenants.has(tenantId)) {
      throw new TenantPausedError(tenantId);
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

  /**
   * Read-only accessor for the per-tenant paused kill switch. Returns
   * `true` when new reservations / cancellations targeting this tenant
   * must fail fast. Used by the cancellation-reversal service.
   */
  isTenantPaused(tenantId: string): boolean {
    return this.pausedTenants.has(tenantId);
  }

  /**
   * Toggle the paused flag for a tenant. Equivalent to
   * `pausedTenants` Set mutation but exposed as a method so callers
   * don't need to reach into the instance.
   */
  setTenantPaused(tenantId: string, paused: boolean): void {
    if (paused) {
      this.pausedTenants.add(tenantId);
    } else {
      this.pausedTenants.delete(tenantId);
    }
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
