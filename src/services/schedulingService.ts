// @ts-nocheck
import type { BookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import type { SlotRepository } from "../modules/slots/slot-repository.js";
import { GraceWindowService, getGraceWindowService } from "./graceWindowService.js";
import { EventEmitter } from "node:events";
import crypto from "crypto";

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

export class BundleNotTransferableError extends Error {
  constructor(readonly bundleId: string) {
    super(`Bundle ${bundleId} is not transferable`);
    this.name = "BundleNotTransferableError";
  }
}

export class CancellationAfterSlotStartError extends Error {
  constructor(
    readonly bookingIntentId: string,
    readonly slotStartTime: number,
    readonly cancelledAt: number,
  ) {
    super(
      `Cannot cancel booking intent ${bookingIntentId} after slot start time ${new Date(slotStartTime).toISOString()}`,
    );
    this.name = "CancellationAfterSlotStartError";
  }
}

export class EscrowRefundLedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowRefundLedgerIntegrityError";
  }
}

export class ImpossibleRescheduleError extends Error {
  constructor(
    readonly bookingId: string,
    readonly reason: string = "No valid candidate schedules found preserving required leg offsets",
  ) {
    super(`Impossible reschedule for booking ${bookingId}: ${reason}`);
    this.name = "ImpossibleRescheduleError";
  }
}

export class InvalidRescheduleRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRescheduleRequestError";
  }
}

export const sagaEvents = new EventEmitter();

export interface MultiLegBookingLeg {
  legId: string;
  slotId: string;
  professional: string;
  startTime: number;
  endTime: number;
  offsetMs?: number;
}

export interface MultiLegBooking {
  bookingId: string;
  buyerId: string;
  tenantId?: string;
  legs: MultiLegBookingLeg[];
  sagaId?: string;
}

export interface RescheduleLegOverride {
  legId: string;
  offsetOverrideMs?: number;
  newSlotId?: string;
  skipReschedule?: boolean;
}

export interface RescheduleOptions {
  bookingId: string;
  buyerId: string;
  tenantId?: string;
  targetAnchorStartTimeMs?: number;
  searchWindow?: {
    startMs: number;
    endMs: number;
  };
  legOverrides?: Record<string, RescheduleLegOverride> | RescheduleLegOverride[];
  maxOptions?: number;
  searchStepMs?: number;
}

export interface CandidateLegSchedule {
  legId: string;
  currentSlotId: string;
  newSlotId: string;
  professional: string;
  currentStartTime: number;
  newStartTime: number;
  newEndTime: number;
  durationMs: number;
  offsetMs: number;
  isOverridden: boolean;
  isPartialKept: boolean;
}

export interface RescheduleCandidateOption {
  optionId: string;
  anchorStartTimeMs: number;
  legs: CandidateLegSchedule[];
  totalDisruptionMs: number;
  disruptionScore: number;
  isFullyAvailable: boolean;
}

export interface ConfirmRescheduleRequest {
  bookingId: string;
  buyerId: string;
  optionId: string;
  candidateOption: RescheduleCandidateOption;
  multiLegBooking: MultiLegBooking;
}

export interface ConfirmRescheduleResult {
  bookingId: string;
  sagaExecutionId: string;
  status: "reexecuted" | "confirmed";
  updatedLegs: CandidateLegSchedule[];
  confirmedAtMs: number;
}

import { escrowMigrationState } from "./escrowMigrationState.js";

export type EscrowRefundStatus =
  | "requested"
  | "ledger_written"
  | "chain_settling"
  | "completed"
  | "failed";

export interface EscrowRefundLedgerEntry {
  id: string;
  bookingIntentId: string;
  buyerId: string;
  supplierId: string;
  refundRequestId: string;
  escrowHoldId: string;
  grossAmountCents: number;
  platformFeeReversedCents: number;
  prepaidTaxReversedCents: number;
  netRefundCents: number;
  currency: string;
  cancelledBySupplierAt: number;
  slotStartTime: number;
  hoursBeforeStart: number;
  chainTxId?: string;
  status: EscrowRefundStatus;
  ledgerHash: string;
  prevLedgerHash: string;
  createdAt: number;
}

export interface SupplierPreSlotCancelResult {
  refundRequestId: string;
  ledgerEntry: EscrowRefundLedgerEntry;
  releasedSlots: string[];
  grossRefund: number;
  platformFeeReversed: number;
  taxReversed: number;
  netRefund: number;
}

export const refundEvents = new EventEmitter();

const REFUND_LEDGER_GENESIS_HASH = "";

export function deriveRefundLedgerHash(
  refundRequestId: string,
  prevHash: string,
  grossAmount: number,
  feeReversed: number,
  taxReversed: number,
  netRefund: number,
  createdAtIso: string,
): string {
  const input =
    `${refundRequestId}|${prevHash}|${grossAmount}|${feeReversed}|${taxReversed}|${netRefund}|${createdAtIso}`;
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

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
  private refundLedger: EscrowRefundLedgerEntry[] = [];
  private refundLedgerByRequestId = new Map<string, EscrowRefundLedgerEntry>();
  private refundLedgerByIntentId = new Map<string, EscrowRefundLedgerEntry[]>();

  private readonly graceWindowService: GraceWindowService;

  constructor(
    private readonly slotRepository: SlotRepository,
    private readonly bookingIntentRepository: BookingIntentRepository,
    graceWindowService?: GraceWindowService,
  ) {
    // Accept an injected instance (for testing) or fall back to the singleton.
    this.graceWindowService = graceWindowService ?? getGraceWindowService();
  }

  resolveGraceWindow(slotId: string): number {
    const slot = this.slotRepository.findById(slotId);
    return this.graceWindowService.resolveGraceWindow(slot?.category);
  }

  noShowDeadlineMs(slotId: string): number {
    const slot = this.slotRepository.findById(slotId);
    if (!slot) throw new SlotNotFoundError(slotId);
    const windowSec = this.resolveGraceWindow(slotId);
    return slot.startTime + windowSec * 1000;
  }

  // ── Reservation ───────────────────────────────────────────────────────────

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

  /**
   * Handle supplier-initiated cancellation BEFORE the slot start time.
   *
   * Guarantees (issue #439):
   *   1. Rejects cancellation if slot has already started.
   *   2. Releases all reserved slots back to bookable state.
   *   3. Computes 100% refund of gross escrowed amount (supplier-forfeit case).
   *   4. Reverses platform fees in full.
   *   5. Reverses any prepaid taxes in full.
   *   6. Appends a hash-chained refund ledger entry for audit / regulatory.
   *   7. Emits a "refund.requested" event for the chain settlement worker.
   *
   * @param bookingIntentId  The booking intent being cancelled by its supplier.
   * @param options          nowMs override for deterministic tests, chainTxId for pre-seeded results.
   * @returns Full breakdown including gross/fee/tax/net and released slot ids.
   */
  handleSupplierCancelBeforeSlotStart(
    bookingIntentId: string,
    options: { nowMs?: () => number; chainTxId?: string } = {},
  ): SupplierPreSlotCancelResult {
    const nowMs = options.nowMs ?? (() => Date.now());
    const cancelledAt = nowMs();

    const intent = this.bookingIntentRepository.findById(bookingIntentId);
    if (!intent) {
      throw new SlotNotFoundError(bookingIntentId);
    }

    const slotStartTime = intent.startTime;
    if (cancelledAt >= slotStartTime) {
      throw new CancellationAfterSlotStartError(bookingIntentId, slotStartTime, cancelledAt);
    }

    const hoursBeforeStart = (slotStartTime - cancelledAt) / (1000 * 60 * 60);

    const pricing = intent.pricingSnapshot;
    const grossEscrowed = pricing?.resolvedPrice ?? 0;
    const currency = pricing?.currency ?? "USD";

    const platformFeePaid = pricing?.platformFeeCents ?? Math.round(grossEscrowed * 0.05);
    const prepaidTaxPaid = pricing?.taxCents ?? Math.round(grossEscrowed * 0.08);

    const grossRefund = grossEscrowed;
    const platformFeeReversed = platformFeePaid;
    const taxReversed = prepaidTaxPaid;
    const netRefund = grossRefund + taxReversed;

    const releasedSlots: string[] = [];
    const slotIds = intent.slotIds ?? [];
    for (const slotId of slotIds) {
      this.releaseSlot(slotId);
      releasedSlots.push(slotId);
    }
    if (intent.bundleId && this.reservedBundles.has(intent.bundleId)) {
      this.releaseBundle(intent.bundleId);
    }

    const refundRequestId = `refund_${crypto.randomUUID()}`;
    const createdDate = new Date(cancelledAt);
    const tailEntry = this.refundLedger.at(-1) ?? null;
    const prevHash = tailEntry ? tailEntry.ledgerHash : REFUND_LEDGER_GENESIS_HASH;
    const ledgerHash = deriveRefundLedgerHash(
      refundRequestId,
      prevHash,
      grossRefund,
      platformFeeReversed,
      taxReversed,
      netRefund,
      createdDate.toISOString(),
    );

    const ledgerEntry: EscrowRefundLedgerEntry = {
      id: crypto.randomUUID(),
      bookingIntentId,
      buyerId: intent.buyerId,
      supplierId: intent.supplierId,
      refundRequestId,
      escrowHoldId: intent.escrowHoldId ?? `hold_${bookingIntentId}`,
      grossAmountCents: grossRefund,
      platformFeeReversedCents: platformFeeReversed,
      prepaidTaxReversedCents: taxReversed,
      netRefundCents: netRefund,
      currency,
      cancelledBySupplierAt: cancelledAt,
      slotStartTime,
      hoursBeforeStart,
      chainTxId: options.chainTxId,
      status: options.chainTxId ? "chain_settling" : "ledger_written",
      ledgerHash,
      prevLedgerHash: prevHash,
      createdAt: cancelledAt,
    };

    this.refundLedger.push(ledgerEntry);
    this.refundLedgerByRequestId.set(refundRequestId, ledgerEntry);
    const existing = this.refundLedgerByIntentId.get(bookingIntentId) ?? [];
    existing.push(ledgerEntry);
    this.refundLedgerByIntentId.set(bookingIntentId, existing);

    refundEvents.emit("refund.requested", {
      refundRequestId,
      bookingIntentId,
      ledgerEntry,
    });

    return {
      refundRequestId,
      ledgerEntry,
      releasedSlots,
      grossRefund,
      platformFeeReversed,
      taxReversed,
      netRefund,
    };
  }

  /**
   * Look up a refund ledger entry by its refundRequestId.
   */
  findRefundByRequestId(refundRequestId: string): EscrowRefundLedgerEntry | undefined {
    return this.refundLedgerByRequestId.get(refundRequestId);
  }

  /**
   * Return all refund ledger entries for a given booking intent id.
   */
  findRefundsByIntentId(bookingIntentId: string): EscrowRefundLedgerEntry[] {
    return [...(this.refundLedgerByIntentId.get(bookingIntentId) ?? [])];
  }

  /**
   * Verify the hash chain integrity of the refund ledger.
   * Returns the index of the first broken entry, or -1 if intact.
   */
  verifyRefundLedgerChain(): { valid: boolean; firstBrokenIndex: number; entriesChecked: number } {
    for (let i = 0; i < this.refundLedger.length; i++) {
      const entry = this.refundLedger[i];
      const expectedPrev = i === 0 ? REFUND_LEDGER_GENESIS_HASH : this.refundLedger[i - 1].ledgerHash;
      if (entry.prevLedgerHash !== expectedPrev) {
        return { valid: false, firstBrokenIndex: i, entriesChecked: i + 1 };
      }

      const expectedHash = deriveRefundLedgerHash(
        entry.refundRequestId,
        entry.prevLedgerHash,
        entry.grossAmountCents,
        entry.platformFeeReversedCents,
        entry.prepaidTaxReversedCents,
        entry.netRefundCents,
        new Date(entry.createdAt).toISOString(),
      );
      if (entry.ledgerHash !== expectedHash) {
        return { valid: false, firstBrokenIndex: i, entriesChecked: i + 1 };
      }
    }
    return { valid: true, firstBrokenIndex: -1, entriesChecked: this.refundLedger.length };
  }

  /**
   * Mark a refund as settled on-chain (called by the settlement reconciler).
   */
  markRefundSettled(refundRequestId: string, chainTxId: string): EscrowRefundLedgerEntry {
    const entry = this.refundLedgerByRequestId.get(refundRequestId);
    if (!entry) {
      throw new EscrowRefundLedgerIntegrityError(`Unknown refundRequestId: ${refundRequestId}`);
    }
    entry.chainTxId = chainTxId;
    entry.status = "completed";
    refundEvents.emit("refund.completed", { refundRequestId, chainTxId, entry });
    return entry;
  }

  /**
   * Mark a refund as failed (e.g. chain settlement rejected).
   */
  markRefundFailed(refundRequestId: string): EscrowRefundLedgerEntry {
    const entry = this.refundLedgerByRequestId.get(refundRequestId);
    if (!entry) {
      throw new EscrowRefundLedgerIntegrityError(`Unknown refundRequestId: ${refundRequestId}`);
    }
    entry.status = "failed";
    refundEvents.emit("refund.failed", { refundRequestId, entry });
    return entry;
  }

  /**
   * For test isolation: clear in-memory refund ledger and maps.
   * @internal
   */
  _clearRefundLedger(): void {
    this.refundLedger.length = 0;
    this.refundLedgerByRequestId.clear();
    this.refundLedgerByIntentId.clear();
  }

  /**
   * Total size of the refund ledger (for tests / metrics).
   */
  refundLedgerSize(): number {
    return this.refundLedger.length;
  }

  // ── Multi-Leg Reschedule Engine ──────────────────────────────────────────

  /**
   * Plans candidate reschedule options for a multi-leg booking.
   * By default, preserves relative offsets between legs unless explicit
   * per-leg overrides (offsetOverrideMs, newSlotId, or skipReschedule) are provided.
   *
   * @param booking Multi-leg booking containing leg details and owner information.
   * @param options Reschedule options including anchor start time, search window, per-leg overrides, and maxOptions.
   * @returns N candidate reschedule options sorted by fewest disruptions (totalDisruptionMs ascending).
   */
  planMultiLegReschedule(
    booking: MultiLegBooking,
    options: RescheduleOptions,
  ): RescheduleCandidateOption[] {
    const tenantId = options.tenantId ?? booking.tenantId;
    if (tenantId && this.pausedTenants.has(tenantId)) {
      throw new TenantPausedError(tenantId);
    }

    if (!booking || !booking.legs || booking.legs.length === 0) {
      throw new InvalidRescheduleRequestError("Booking must contain at least one leg");
    }

    if (booking.buyerId && options.buyerId && booking.buyerId !== options.buyerId) {
      throw new InvalidRescheduleRequestError(
        `Buyer ${options.buyerId} is not authorized to reschedule booking owned by ${booking.buyerId}`,
      );
    }

    const sortedLegs = [...booking.legs].sort((a, b) => a.startTime - b.startTime);
    const anchorLeg = sortedLegs[0];
    const leg0StartTime = anchorLeg.startTime;

    const legOverridesMap = new Map<string, RescheduleLegOverride>();
    if (options.legOverrides) {
      if (Array.isArray(options.legOverrides)) {
        for (const override of options.legOverrides) {
          legOverridesMap.set(override.legId, override);
        }
      } else if (typeof options.legOverrides === "object") {
        for (const [legId, override] of Object.entries(options.legOverrides)) {
          legOverridesMap.set(legId, override);
        }
      }
    }

    const legConfigs = sortedLegs.map((leg, index) => {
      const override = legOverridesMap.get(leg.legId);
      const defaultOffset = leg.offsetMs ?? (leg.startTime - leg0StartTime);
      const offsetMs =
        override?.offsetOverrideMs !== undefined ? override.offsetOverrideMs : defaultOffset;
      const durationMs = leg.endTime - leg.startTime;
      return {
        leg,
        index,
        offsetMs,
        durationMs,
        override,
        isOverridden:
          override?.offsetOverrideMs !== undefined || override?.newSlotId !== undefined,
        skipReschedule: override?.skipReschedule ?? false,
      };
    });

    const maxOptions = options.maxOptions ?? 3;
    const stepMs = options.searchStepMs ?? 30 * 60 * 1000; // 30 minutes step default

    const candidateAnchors: number[] = [];

    if (options.targetAnchorStartTimeMs !== undefined) {
      const target = options.targetAnchorStartTimeMs;
      candidateAnchors.push(target);

      const searchStart = options.searchWindow?.startMs ?? target - 2 * 3600_000;
      const searchEnd = options.searchWindow?.endMs ?? target + 2 * 3600_000;

      for (let t = searchStart; t <= searchEnd; t += stepMs) {
        if (t !== target) {
          candidateAnchors.push(t);
        }
      }
    } else if (options.searchWindow) {
      for (let t = options.searchWindow.startMs; t <= options.searchWindow.endMs; t += stepMs) {
        candidateAnchors.push(t);
      }
    } else {
      const base = leg0StartTime;
      candidateAnchors.push(base);
      for (let offset = stepMs; offset <= 4 * 3600_000; offset += stepMs) {
        candidateAnchors.push(base + offset);
        candidateAnchors.push(base - offset);
      }
    }

    const candidateOptions: RescheduleCandidateOption[] = [];
    const allSlots = this.slotRepository.list();

    for (const anchorStartMs of candidateAnchors) {
      if (anchorStartMs <= 0) continue;

      let validForThisAnchor = true;
      const proposedLegs: CandidateLegSchedule[] = [];
      let optionTotalDisruption = 0;

      for (const config of legConfigs) {
        const { leg, offsetMs, durationMs, override, isOverridden, skipReschedule } = config;

        let newStart: number;
        let newEnd: number;
        let candidateSlotId: string | undefined;

        if (skipReschedule) {
          newStart = leg.startTime;
          newEnd = leg.endTime;
          candidateSlotId = leg.slotId;
        } else {
          newStart = anchorStartMs + offsetMs;
          newEnd = newStart + durationMs;

          if (override?.newSlotId) {
            const specificSlot = allSlots.find((s) => s.id === override.newSlotId);
            if (
              specificSlot &&
              (specificSlot.bookable || specificSlot.id === leg.slotId) &&
              specificSlot.professional === leg.professional &&
              specificSlot.startTime === newStart &&
              specificSlot.endTime === newEnd
            ) {
              candidateSlotId = specificSlot.id;
            } else {
              validForThisAnchor = false;
              break;
            }
          } else {
            const matchingSlot = allSlots.find(
              (s) =>
                s.professional === leg.professional &&
                (s.bookable || s.id === leg.slotId) &&
                s.startTime === newStart &&
                s.endTime === newEnd,
            );

            if (matchingSlot) {
              candidateSlotId = matchingSlot.id;
            } else {
              const flexSlot = allSlots.find(
                (s) =>
                  s.professional === leg.professional &&
                  (s.bookable || s.id === leg.slotId) &&
                  s.startTime <= newStart &&
                  s.endTime >= newEnd,
              );
              if (flexSlot) {
                candidateSlotId = flexSlot.id;
              } else {
                validForThisAnchor = false;
                break;
              }
            }
          }
        }

        const disruption = Math.abs(newStart - leg.startTime);
        optionTotalDisruption += disruption;

        proposedLegs.push({
          legId: leg.legId,
          currentSlotId: leg.slotId,
          newSlotId: candidateSlotId!,
          professional: leg.professional,
          currentStartTime: leg.startTime,
          newStartTime: newStart,
          newEndTime: newEnd,
          durationMs,
          offsetMs,
          isOverridden,
          isPartialKept: skipReschedule,
        });
      }

      if (validForThisAnchor && proposedLegs.length === legConfigs.length) {
        const optionId = `opt_${crypto.randomUUID()}`;
        candidateOptions.push({
          optionId,
          anchorStartTimeMs: anchorStartMs,
          legs: proposedLegs,
          totalDisruptionMs: optionTotalDisruption,
          disruptionScore: optionTotalDisruption,
          isFullyAvailable: true,
        });
      }
    }

    if (candidateOptions.length === 0) {
      throw new ImpossibleRescheduleError(
        booking.bookingId,
        "No candidate slot combinations available preserving requested leg offsets",
      );
    }

    // Sort candidate options by disruption score ascending (fewest disruptions first)
    candidateOptions.sort((a, b) => a.disruptionScore - b.disruptionScore);

    return candidateOptions.slice(0, maxOptions);
  }

  /**
   * Confirms a chosen reschedule candidate option.
   * Releases original slots and reserves new candidate slots atomically.
   * Triggers saga re-execution event.
   *
   * @param request Confirmation request including booking, buyer ID, and chosen candidate option.
   * @returns ConfirmRescheduleResult with status and saga execution details.
   */
  confirmMultiLegReschedule(request: ConfirmRescheduleRequest): ConfirmRescheduleResult {
    const { bookingId, buyerId, candidateOption, multiLegBooking } = request;

    const tenantId = multiLegBooking.tenantId;
    if (tenantId && this.pausedTenants.has(tenantId)) {
      throw new TenantPausedError(tenantId);
    }

    if (multiLegBooking.buyerId && buyerId && multiLegBooking.buyerId !== buyerId) {
      throw new InvalidRescheduleRequestError(
        `Buyer ${buyerId} is not authorized to confirm reschedule for booking owned by ${multiLegBooking.buyerId}`,
      );
    }

    if (!candidateOption || !candidateOption.legs || candidateOption.legs.length === 0) {
      throw new InvalidRescheduleRequestError("Invalid candidate option provided for confirmation");
    }

    const releasedSlotIds: string[] = [];
    const reservedSlotIds: string[] = [];

    try {
      // Step 1: Release old slots for legs that are being rescheduled
      for (const leg of candidateOption.legs) {
        if (!leg.isPartialKept && leg.currentSlotId !== leg.newSlotId) {
          try {
            this.releaseSlot(leg.currentSlotId);
            releasedSlotIds.push(leg.currentSlotId);
          } catch {
            // Ignore if slot was not found or already free
          }
        }
      }

      // Step 2: Reserve new candidate slots
      for (const leg of candidateOption.legs) {
        if (!leg.isPartialKept && leg.currentSlotId !== leg.newSlotId) {
          this.reserveSlot(leg.newSlotId);
          reservedSlotIds.push(leg.newSlotId);
        }
      }
    } catch (error) {
      // Rollback on failure: release newly reserved slots, re-reserve released old slots
      for (const slotId of reservedSlotIds) {
        try {
          this.releaseSlot(slotId);
        } catch {}
      }
      for (const slotId of releasedSlotIds) {
        try {
          this.reserveSlot(slotId);
        } catch {}
      }
      throw new Error(
        `Failed to confirm reschedule for booking ${bookingId}: ${(error as Error).message}`,
      );
    }

    const sagaExecutionId = `saga_${crypto.randomUUID()}`;
    const confirmedAtMs = Date.now();

    sagaEvents.emit("saga.reexecute", {
      bookingId,
      buyerId,
      sagaExecutionId,
      optionId: candidateOption.optionId,
      updatedLegs: candidateOption.legs,
      confirmedAtMs,
    });

    return {
      bookingId,
      sagaExecutionId,
      status: "reexecuted",
      updatedLegs: candidateOption.legs,
      confirmedAtMs,
    };
  }
}
