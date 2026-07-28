import type { BookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import type { SlotRepository } from "../modules/slots/slot-repository.js";
import {
  GraceWindowService,
  getGraceWindowService,
  DEFAULT_GRACE_WINDOW_SECONDS,
} from "./graceWindowService.js";

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
  readonly slotId: string;
  readonly validUntil: number;

  constructor(slotId: string, validUntil: number) {
    super(`Slot ${slotId} bundle has expired (valid until ${new Date(validUntil).toISOString()})`);
    this.name = "SlotExpiredError";
    this.slotId = slotId;
    this.validUntil = validUntil;
  }
}

export class EscrowPausedError extends Error {
  constructor() {
    super(`Escrow contract migration in progress: new holds are temporarily paused`);
    this.name = "EscrowPausedError";
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
 * Grace-window awareness
 * ----------------------
 * Each slot carries an optional `category` field (e.g. "medical",
 * "fitness").  The `resolveGraceWindow` method looks up the effective
 * grace-window duration (in **seconds**) for that category via the
 * injected GraceWindowService.  Callers (e.g. the no-show detection
 * job) use this to determine how long to wait after `slot.startTime`
 * before evaluating absence.
 *
 * In a production DB these operations would be wrapped in a single
 * transaction so the slot update and intent update commit or roll back
 * together.
 */
export class SchedulingService {
  public pausedTenants: Set<string> = new Set();
  private reservedBundles: Map<string, Set<string>> = new Map();
  private readonly graceWindowService: GraceWindowService;

  constructor(
    private readonly slotRepository: SlotRepository,
    private readonly bookingIntentRepository: BookingIntentRepository,
    graceWindowService?: GraceWindowService,
  ) {
    // Accept an injected instance (for testing) or fall back to the singleton.
    this.graceWindowService = graceWindowService ?? getGraceWindowService();
  }

  // ── Reservation ───────────────────────────────────────────────────────────

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
      // Rollback all already-reserved slots so the operation is atomic.
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

  // ── Grace-window ──────────────────────────────────────────────────────────

  /**
   * Resolve the effective no-show grace window (in **seconds**) for a slot.
   *
   * Resolution order:
   *   1. Category-specific config (set via the admin API)
   *   2. System default ({@link DEFAULT_GRACE_WINDOW_SECONDS} = 900 s)
   *
   * @param slotId - The slot whose grace window to resolve.
   * @returns Grace window in seconds.  Never negative.
   * @throws {SlotNotFoundError} if the slot does not exist.
   */
  resolveGraceWindow(slotId: string): number {
    const slot = this.slotRepository.findById(slotId);
    if (!slot) {
      throw new SlotNotFoundError(slotId);
    }
    return this.graceWindowService.resolve(slot.category ?? null);
  }

  /**
   * Return the Unix epoch millisecond timestamp after which a no-show
   * evaluation should fire for this slot.
   *
   *   deadline = slot.startTime + graceWindowSeconds * 1000
   *
   * @param slotId - The slot to compute the deadline for.
   * @returns Epoch ms deadline.
   * @throws {SlotNotFoundError} if the slot does not exist.
   */
  noShowDeadlineMs(slotId: string): number {
    const slot = this.slotRepository.findById(slotId);
    if (!slot) {
      throw new SlotNotFoundError(slotId);
    }
    const graceWindowMs = this.graceWindowService.resolve(slot.category ?? null) * 1000;
    return slot.startTime + graceWindowMs;
  }
}
