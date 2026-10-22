import type { AuthContext } from "../../middleware/auth.js";
import type { SlotRepository } from "../slots/slot-repository.js";
import type {
  BookingIntentRecord,
  BookingIntentRepository,
  BookingIntentStatus,
  BookingType,
  CancellationPolicySnapshot,
} from "./booking-intent-repository.js";
import {
  SchedulingService,
  BundleNotTransferableError,
  RecurringBookingRulesEngine,
  RecurringBookingRulesError,
} from "../../services/schedulingService.js";
import { BundleTransferabilityService } from "../../services/bundleTransferabilityService.js";
import { withSpan } from "../../tracing/hooks.js";
import { AppError } from "../../errors/AppError.js";
import { ERROR_CODES } from "../../errors/errorCodes.js";
import { sanitizeNote } from "../../utils/redact.js";
import type { StrategyId } from "../../services/pricingStrategy.js";
import { resolvePricingSnapshot } from "./pricing-snapshot.js";
import {
  CancellationPolicyService,
  RefundBreakdown,
  createDefaultRegistry,
  VersionedPolicyRegistry,
  LEGACY_V1_VERSION,
} from "../../services/cancellationPolicy.js";
import {
  HoldFeePolicyService,
  createEmptyHoldFeeRegistry,
  HoldFeePolicyRegistry,
  type HoldFeePolicy,
} from "../../services/holdFeePolicy.js";
import {
  defaultSupplierCancellationOverrideStore,
  type SupplierCancellationOverrideStore,
} from "../../services/supplierCancellationOverrideStore.js";
import { CheckoutSessionService } from "../../services/checkout.js";
import { writeReputationScore } from "../../services/reputationWriteAudit.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";

export interface CreateBookingIntentInput {
  slotId: string;
  note?: string;
  pricingStrategyId?: StrategyId;
  basePrice?: number;
  bookingType?: BookingType;
  holdDeadlineMs?: number;
  buyerCurrency?: import("../../utils/amount.js").SupportedCurrencies;
}

export interface CreateRecurringBookingInput {
  rrule: string;
  note?: string;
  bookingType?: BookingType;
  holdDeadlineMs?: number;
  buyerCurrency?: import("../../utils/amount.js").SupportedCurrencies;
}

export interface AutoRefundResult {
  intentId: string;
  success: boolean;
  refundedAmountCents: number;
  error?: string;
}

export interface SupplierPolicies {
  getHoldPolicy(professionalId: string): HoldFeePolicy;
}

/**
 * Narrow structural view of `StrikeService` used by `markNoShow`.
 *
 * Declaring only the slice the service depends on keeps the strike
 * collaborator trivially fakeable in tests while the real singleton
 * satisfies it structurally.
 */
export interface NoShowStrikeService {
  issueStrike(params: {
    buyerId: string;
    intentId?: string;
    slotId?: string;
    reason?: string;
    issuedAt?: number;
  }): Promise<{ strike: { id: string }; autoSuspended: boolean }>;
}

/**
 * Grace window applied after a slot's start time before a supplier may
 * declare a no-show. Mirrors `DEFAULT_GRACE_WINDOW_SECONDS` (900 s = 15 min),
 * the platform-wide default also used by the no-show detection job.
 */
export const DEFAULT_NO_SHOW_GRACE_MS = DEFAULT_GRACE_WINDOW_SECONDS * 1000;

export interface BookingIntentServiceOptions {
  /** Strike collaborator; defaults to the module-level `strikeService` singleton. */
  strikeService?: NoShowStrikeService;
  /**
   * Explicit grace window (ms) after `intent.startTime`. When omitted, the
   * per-slot-category window from the injected `GraceWindowService` applies
   * (admin-configurable, default 15 minutes).
   */
  noShowGraceMs?: number;
  /** Grace-window resolver; defaults to the application singleton. */
  graceWindowService?: Pick<GraceWindowService, "resolve">;
}

export class BookingIntentError extends AppError {
  constructor(
    readonly status: number,
    message: string,
    codeOverride?: string,
  ) {
    const code =
      codeOverride ??
      (status === 400
        ? ERROR_CODES.BAD_REQUEST.code
        : status === 403
          ? ERROR_CODES.FORBIDDEN.code
          : status === 404
            ? ERROR_CODES.NOT_FOUND.code
            : status === 409
              ? ERROR_CODES.CONFLICT.code
              : status === 422
                ? ERROR_CODES.UNPROCESSABLE_ENTITY.code
                : ERROR_CODES.INTERNAL_ERROR.code);
    super(message, status, code, true);
    this.name = "BookingIntentError";
  }
}

export class BookingIntentService {
  private cancellationPolicyService: CancellationPolicyService;
  private getPolicyRegistrySync: () => VersionedPolicyRegistry;
  private holdFeePolicyService: HoldFeePolicyService;
  private holdFeeRegistry: HoldFeePolicyRegistry;
  private readonly strikeService: NoShowStrikeService;
  private readonly noShowGraceMsOption: number | undefined = undefined;
  private readonly graceWindowService: Pick<GraceWindowService, "resolve">;

  constructor(
    private readonly bookingIntentRepository: BookingIntentRepository,
    private readonly slotRepository: SlotRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly nowMs: () => number = () => Date.now(),
    policyRegistry?: VersionedPolicyRegistry,
    holdFeeRegistry?: HoldFeePolicyRegistry,
    private readonly fxRateProvider?: import("../../services/fxRateProvider.js").FxRateProvider,
    supplierOverrideStore?: SupplierCancellationOverrideStore,
  ) {
    const reg = policyRegistry ?? createDefaultRegistry();
    this.getPolicyRegistrySync = () => reg;
    this.cancellationPolicyService = new CancellationPolicyService({
      getPolicyRegistrySync: this.getPolicyRegistrySync,
      nowMs: this.nowMs,
      nowIso: this.now,
      supplierOverrideStore: supplierOverrideStore ?? defaultSupplierCancellationOverrideStore,
    });
    this.holdFeeRegistry = holdFeeRegistry ?? createEmptyHoldFeeRegistry();
    this.holdFeePolicyService = new HoldFeePolicyService({
      getRegistry: () => this.holdFeeRegistry,
      nowMs: this.nowMs,
    });
    this.strikeService = options.strikeService ?? strikeService;
    this.graceWindowService = options.graceWindowService ?? getGraceWindowService();

    if (options.noShowGraceMs !== undefined) {
      if (!Number.isFinite(options.noShowGraceMs) || options.noShowGraceMs < 0) {
        throw new RangeError("noShowGraceMs must be a non-negative number.");
      }
      this.noShowGraceMsOption = Math.floor(options.noShowGraceMs);
    }
  }

  /**
   * Effective no-show grace window (ms) for a slot: an explicit constructor
   * override wins, otherwise the admin-configurable per-category window is
   * used (defaulting to 15 minutes).
   */
  private resolveNoShowGraceMs(slotId: string): number {
    if (this.noShowGraceMsOption !== undefined) {
      return this.noShowGraceMsOption;
    }
    const slot = this.slotRepository.findById(slotId);
    return this.graceWindowService.resolve(slot?.category) * 1000;
  }

  private get schedulingService(): SchedulingService {
    return new SchedulingService(this.slotRepository, this.bookingIntentRepository);
  }

  private get bundleTransferabilityService(): BundleTransferabilityService {
    return new BundleTransferabilityService(this.slotRepository);
  }

  private captureCancellationPolicySnapshot(professionalId?: string): CancellationPolicySnapshot {
    return this.cancellationPolicyService.snapshotCurrentPolicy(undefined, professionalId);
  }

  private captureHoldFeePolicySnapshot(professionalId: string) {
    return this.holdFeePolicyService.snapshotForSupplier(professionalId);
  }

  /**
   * Frees a slot after a terminal intent transition (cancel, refund, no-show,
   * expiry).
   *
   * `SchedulingService.releaseSlot` throws when the slot row is absent, which
   * is the right contract for its direct callers. These transitions must not
   * fail for that reason: the intent may have been seeded directly, or the
   * slot already purged. Releasing an already-absent slot is a no-op, so the
   * failure is swallowed and the transition still succeeds.
   */
  private releaseSlotBestEffort(slotId: string): void {
    try {
      this.schedulingService.releaseSlot(slotId);
    } catch {
      // Slot row already gone — nothing left to release.
    }
  }

  async createIntent(
    input: CreateBookingIntentInput,
    actor: AuthContext,
  ): Promise<BookingIntentRecord> {
    const slot = this.slotRepository.findById(input.slotId);
    if (!slot) {
      throw new BookingIntentError(404, "Selected slot was not found.");
    }

    if (!slot.bookable) {
      throw new BookingIntentError(409, "Selected slot is not bookable.");
    }

    if (slot.validUntil !== undefined && slot.validUntil !== null) {
      const currentTime = this.nowMs();
      if (currentTime >= slot.validUntil) {
        throw new BookingIntentError(
          422,
          "Bundle for this slot has expired. Redemption is no longer available.",
          ERROR_CODES.BUNDLE_EXPIRED.code,
        );
      }
    }

    // Enforce bundle transferability — non-transferable bundles cannot be
    // listed for resale unless the actor is an admin (override path).
    try {
      this.bundleTransferabilityService.assertBundleTransferable(slot, actor);
    } catch (err) {
      if (err instanceof BundleNotTransferableError) {
        throw new BookingIntentError(422, err.message, ERROR_CODES.BUNDLE_NOT_TRANSFERABLE.code);
      }
      throw err;
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

    let pricingSnapshot: PricingSnapshot | undefined;
    if (slot.pricingStrategy) {
      const ps = slot.pricingStrategy;
      const allIntents = await this.bookingIntentRepository.listAll();
      const activeBookings = allIntents.filter(
        (i) => i.slotId === slot.id && (i.status === "pending" || i.status === "confirmed"),
      ).length;
      const capacity = ps.capacity ?? 1;
      const currentMs = this.nowMs();

      const result = resolvePrice(ps.strategyId, {
        basePrice: ps.basePrice,
        slotStartMs: slot.startTime,
        nowMs: currentMs,
        activeBookings,
        capacity,
        config: ps.config,
      });

      pricingSnapshot = {
        strategyId: result.strategyId,
        resolvedPrice: result.price,
        basePrice: ps.basePrice,
        slotStartMs: slot.startTime,
        nowMs: currentMs,
        activeBookings,
        capacity,
        config: ps.config,
      };
    }

    const cancellationPolicySnapshot = this.captureCancellationPolicySnapshot(slot.professional);
    const holdFeePolicySnapshot = this.captureHoldFeePolicySnapshot(slot.professional);

    let fxRateSnapshot:
      | { rate: number; baseCurrency: string; targetCurrency: string; capturedAtMs: number }
      | undefined;
    if (slot.currency && input.buyerCurrency && this.fxRateProvider) {
      try {
        const rate = await this.fxRateProvider.getRate(slot.currency, input.buyerCurrency);
        fxRateSnapshot = {
          rate,
          baseCurrency: slot.currency,
          targetCurrency: input.buyerCurrency,
          capturedAtMs: this.nowMs(),
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to fetch FX rate";
        throw new BookingIntentError(500, message);
      }
    }

    const bookingType = input.bookingType ?? "standard";
    const status = bookingType === "refundable_hold" ? "hold_placed" : "pending";
    const holdPlacedAt = bookingType === "refundable_hold" ? this.now() : undefined;
    const holdUntilMs = bookingType === "refundable_hold" ? input.holdDeadlineMs : undefined;

    const intent = await this.bookingIntentRepository.create({
      slotId: slot.id,
      professional: slot.professional,
      customerId: actor.userId,
      startTime: slot.startTime,
      endTime: slot.endTime,
      status,
      note: input.note,
      createdAt: this.now(),
      bookingType,
      holdUntilMs,
      holdPlacedAt,
      pricingSnapshot,
      cancellationPolicySnapshot,
      holdFeePolicySnapshot,
      fxRateSnapshot,
    });

    this.schedulingService.reserveSlot(input.slotId);

    return intent;
  }

  async getIntent(intentId: string, actor: AuthContext): Promise<BookingIntentRecord> {
    const intent = await this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (intent.customerId !== actor.userId && actor.role !== "admin") {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    return intent;
  }

  async listIntents(actor: AuthContext): Promise<BookingIntentRecord[]> {
    if (actor.role === "admin") {
      return this.bookingIntentRepository.listAll();
    }
    return this.bookingIntentRepository.listByCustomer(actor.userId);
  }

  async createRecurringIntents(
    input: CreateRecurringBookingInput,
    actor: AuthContext,
  ): Promise<{ successes: BookingIntentRecord[]; failures: { date: string; reason: string }[] }> {
    const engine = new RecurringBookingRulesEngine({
      slotRepository: this.slotRepository,
      bookingIntentRepository: this.bookingIntentRepository,
      now: this.now,
      assertBundleTransferable: (slot, act) =>
        this.bundleTransferabilityService.assertBundleTransferable(slot, {
          userId: String(act.userId),
          role: (act.role ?? "customer") as AuthContext["role"],
          claims: {} as import("../../utils/jwt.js").VerifiedJwtPayload,
        }),
      capturePolicySnapshots: (professionalId) => ({
        cancellationPolicySnapshot: this.captureCancellationPolicySnapshot(professionalId),
        holdFeePolicySnapshot: this.captureHoldFeePolicySnapshot(professionalId),
      }),
    });

    try {
      const recurringActor: import("../../services/schedulingService.js").RecurringBookingActor = {
        ...actor,
      };
      const report = await engine.createRecurringBookings(input.rrule, recurringActor, {
        note: input.note,
        bookingType: input.bookingType,
        holdDeadlineMs: input.holdDeadlineMs,
      });
      return report;
    } catch (err) {
      if (err instanceof RecurringBookingRulesError) {
        throw new BookingIntentError(400, err.message);
      }
      throw err;
    }
  }

  async confirmIntent(intentId: string, actor: AuthContext): Promise<BookingIntentRecord> {
    const intent = await this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (intent.customerId !== actor.userId && actor.role !== "admin") {
      throw new BookingIntentError(
        403,
        "Only the intent owner or admin can confirm a booking intent.",
      );
    }

    const canConfirm = intent.status === "pending" || intent.status === "hold_placed";
    if (!canConfirm) {
      throw new BookingIntentError(409, `Cannot confirm intent with status "${intent.status}".`);
    }

    return this.bookingIntentRepository.updateStatus(intentId, "confirmed");
  }

  async cancelIntent(intentId: string, actor: AuthContext): Promise<BookingIntentRecord> {
    const intent = await this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (intent.customerId !== actor.userId && actor.role !== "admin") {
      throw new BookingIntentError(403, "You are not authorized to cancel this booking intent.");
    }

    const canCancel = intent.status === "pending" || intent.status === "hold_placed";
    if (!canCancel) {
      throw new BookingIntentError(409, `Cannot cancel intent with status "${intent.status}".`);
    }

    const isHold = intent.bookingType === "refundable_hold" && intent.status === "hold_placed";
    const refundAmount = isHold ? this.resolveIntentPrice(intent) : 0;

    const updates: Partial<BookingIntentRecord> = isHold
      ? {
          status: "hold_refunded",
          refundedAt: this.now(),
          refundMetadata: {
            refundedAt: this.now(),
            refundedAmountCents: refundAmount,
            refundReason: actor.role === "admin" ? "admin_action" : "customer_cancel",
          },
        }
      : {
          status: "cancelled",
        };

    const updated = await this.bookingIntentRepository.update(intentId, updates);

    this.releaseSlotBestEffort(intent.slotId);

    return updated;
  }

  async previewCancel(intentId: string, actor: AuthContext): Promise<RefundBreakdown> {
    const intent = await this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (intent.customerId !== actor.userId && actor.role !== "admin") {
      throw new BookingIntentError(
        403,
        "You are not authorized to preview cancel this booking intent.",
      );
    }

    return this.cancellationPolicyService.calculateRefund(intent);
  }

  /**
   * Read-only hold state for a single intent, backing GET /:id/hold-status so
   * clients can poll a refundable hold without refetching the whole intent.
   *
   * Applies the same ownership rule as cancelIntent: only the intent owner or
   * an admin may read it.
   */
  async getHoldStatus(
    intentId: string,
    actor: AuthContext,
  ): Promise<{
    intentId: string;
    bookingType: BookingIntentRecord["bookingType"];
    status: BookingIntentRecord["status"];
    isRefundableHold: boolean;
    holdUntilMs: number | undefined;
    holdPlacedAt: string | undefined;
    refundableNow: boolean;
    refundAmountCents: number;
  }> {
    const intent = await this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (intent.customerId !== actor.userId && actor.role !== "admin") {
      throw new BookingIntentError(403, "You are not authorized to view this booking intent.");
    }

    const isRefundableHold = intent.bookingType === "refundable_hold";
    const refundableNow = isRefundableHold && intent.status === "hold_placed";

    return {
      intentId: intent.id,
      bookingType: intent.bookingType,
      status: intent.status,
      isRefundableHold,
      holdUntilMs: intent.holdUntilMs,
      holdPlacedAt: intent.holdPlacedAt,
      refundableNow,
      refundAmountCents: refundableNow ? this.resolveIntentPrice(intent) : 0,
    };
  }

  /**
   * Refunds an active booking intent and transitions it to `cancelled`.
   *
   * Product rule for refund calculation:
   * - Pre-start cancellations (`cancelledAtMs < intent.startTime`): computed via
   *   `this.cancellationPolicyService.calculateRefund(intent)`, which applies
   *   the grandfathered `cancellationPolicySnapshot` (tiered notice windows,
   *   flat/percentage fees, tax reversal) and deducts any non-refundable
   *   `holdFeePolicySnapshot` retention. This guarantees `previewCancel` and
   *   `refundIntent` produce identical amounts under the same clock and registry.
   * - In-progress or elapsed sessions (`cancelledAtMs >= intent.startTime`):
   *   tiered pre-start notice windows no longer apply once the session has
   *   started; the refund uses linear duration-based proration via
   *   `CheckoutSessionService.calculateDurationBasedRefund` over the remaining
   *   session time (0 once the slot has fully elapsed).
   */
  refundIntent(
    intentId: string,
    actor: AuthContext,
    input: { reason?: string; cancelledAtMs?: number } = {},
  ): Promise<{
    intent: BookingIntentRecord;
    refundAmountCents: number;
    refundRatio: number;
    consumedRatio: number;
    reason: string;
    policyVersionId: string;
    fee: number;
    holdFee: number;
    taxReversal: number;
    breakdown: RefundBreakdown;
  } {
    const intent = this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (intent.customerId !== actor.userId && actor.role !== "admin") {
      throw new BookingIntentError(403, "You are not authorized to refund this booking intent.");
    }

    if (intent.refundMetadata || intent.refundedAt) {
      throw new BookingIntentError(409, "Intent has already been refunded.");
    }

    if (
      intent.status === "cancelled" ||
      intent.status === "expired" ||
      intent.status === "hold_refunded" ||
      intent.status === "no_show"
    ) {
      throw new BookingIntentError(409, `Cannot refund intent with status "${intent.status}".`);
    }

    const currentNowMs = this.nowMs();
    let effectiveCancelledAtMs: number;

    if (actor.role === "admin" && input.cancelledAtMs !== undefined) {
      if (!Number.isFinite(input.cancelledAtMs)) {
        throw new BookingIntentError(400, "cancelledAtMs must be a valid number.");
      }
      if (input.cancelledAtMs > currentNowMs) {
        throw new BookingIntentError(400, "Admin override cancelledAtMs cannot be in the future.");
      }
      effectiveCancelledAtMs = input.cancelledAtMs;

      defaultAuditLogger
        .log({
          action: "booking_intent.admin_override_cancelled_at",
          status: "success",
          resource: `booking_intent:${intentId}`,
          metadata: {
            bookingIntentId: intentId,
            adminUserId: actor.userId,
            overrideCancelledAtMs: effectiveCancelledAtMs,
            serverNowMs: currentNowMs,
          },
        })
        .catch(() => {});
    } else {
      effectiveCancelledAtMs = currentNowMs;
    }

    let refundAmountCents: number;
    let refundRatio: number;
    let consumedRatio: number;
    let breakdown: RefundBreakdown;

    if (cancelledAtMs < intent.startTime) {
      breakdown = this.cancellationPolicyService.calculateRefund(intent);
      refundAmountCents = breakdown.netRefund;
      refundRatio = breakdown.tierApplied?.refundRatio ?? 0;
      consumedRatio = 0;
    } else {
      const amountCents = this.resolveIntentPrice(intent);
      const refundSummary = CheckoutSessionService.calculateDurationBasedRefund({
        amountCents,
        startTimeMs: intent.startTime,
        endTimeMs: intent.endTime,
        nowMs: cancelledAtMs,
        curve: "linear",
      });
      const policyVersionId =
        intent.cancellationPolicySnapshot?.policyVersionId ?? LEGACY_V1_VERSION.versionId;
      breakdown = {
        fee: 0,
        taxReversal: 0,
        netRefund: refundSummary.refundAmountCents,
        policyVersion: policyVersionId,
        tierApplied: null,
        hoursUntilStart: (intent.startTime - cancelledAtMs) / (1000 * 60 * 60),
        basePrice: amountCents,
        holdFee: 0,
      };
      refundAmountCents = refundSummary.refundAmountCents;
      refundRatio = refundSummary.remainingRatio;
      consumedRatio = refundSummary.consumedRatio;
    }

    const reason = (input.reason ?? "partial_refund").trim() || "partial_refund";
    const updated = await this.bookingIntentRepository.update(intentId, {
      status: "cancelled",
      refundedAt: this.now(),
      refundMetadata: {
        refundedAt: this.now(),
        refundedAmountCents: refundAmountCents,
        refundReason: reason,
      },
    });

    this.releaseSlotBestEffort(intent.slotId);

    return {
      intent: updated,
      refundAmountCents,
      refundRatio,
      consumedRatio,
      reason,
      policyVersionId: breakdown.policyVersion,
      fee: breakdown.fee,
      holdFee: breakdown.holdFee,
      taxReversal: breakdown.taxReversal,
      breakdown,
    };
  }

  async expireIntent(intentId: string): Promise<BookingIntentRecord> {
    const intent = await this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    const canExpire = intent.status === "pending" || intent.status === "hold_placed";
    if (!canExpire) {
      throw new BookingIntentError(409, `Cannot expire intent with status "${intent.status}".`);
    }

    const updated = await this.bookingIntentRepository.updateStatus(intentId, "expired");

    this.releaseSlotBestEffort(intent.slotId);

    return updated;
  }

  private resolveIntentPrice(intent: BookingIntentRecord): number {
    if (intent.pricingSnapshot) {
      return intent.pricingSnapshot.resolvedPrice;
    }
    return 0;
  }

  async autoRefundHold(intentId: string): Promise<BookingIntentRecord> {
    const intent = await this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }
    const refundAmount = this.resolveIntentPrice(intent);
    const updated = await this.bookingIntentRepository.update(intentId, {
      status: "hold_refunded",
      refundedAt: this.now(),
      refundMetadata: {
        refundedAt: this.now(),
        refundedAmountCents: refundAmount,
        refundReason: "hold_auto_refund",
      },
    });
    this.releaseSlotBestEffort(intent.slotId);
    return updated;
  }

  /**
   * Marks a confirmed booking as a buyer no-show.
   *
   * Guards (both return 409):
   *  - only a `confirmed` intent can be marked — a pending or held booking
   *    has not been agreed to run yet;
   *  - the clock must be at or past `startTime + noShowGraceMs`, so a supplier
   *    cannot forfeit funds (and penalise the buyer) before the appointment
   *    has actually begun.
   *
   * The buyer strike is issued *before* the status transition so a failing
   * strike service leaves the intent untouched instead of half-applied.
   */
  async markNoShow(
    intentId: string,
    actor: AuthContext,
    input: { reason?: string; forfeitRatio?: number } = {},
  ): Promise<{
    intent: BookingIntentRecord;
    status: BookingIntentStatus;
    buyerId: string;
    supplierId: string;
    forfeitAmountCents: number;
    strikeId: string;
    autoSuspended: boolean;
    reason: string;
  }> {
    const intent = await this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (actor.role !== "admin" && intent.professional !== actor.userId) {
      throw new BookingIntentError(
        403,
        "Only the supplier can mark this booking intent as a no-show.",
      );
    }

    if (intent.status !== "confirmed") {
      throw new BookingIntentError(
        409,
        `Cannot mark intent with status "${intent.status}" as a no-show.`,
      );
    }

    const graceMs = this.resolveNoShowGraceMs(intent.slotId);
    const eligibleAtMs = intent.startTime + graceMs;
    if (this.nowMs() < eligibleAtMs) {
      throw new BookingIntentError(
        409,
        `Cannot mark a no-show before the booked slot has started (start time + ${graceMs}ms grace).`,
      );
    }

    const ratio = input.forfeitRatio ?? 0.2;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
      throw new BookingIntentError(400, "forfeitRatio must be a number between 0 and 1.");
    }

    const baseAmount = this.resolveIntentPrice(intent);
    const forfeitAmountCents = Math.round(baseAmount * ratio);
    const reason = (input.reason ?? "Buyer no-show").trim();
    const normalizedReason = reason.length > 0 ? reason : "Buyer no-show";

    const updated = await this.bookingIntentRepository.update(intentId, {
      status: "no_show",
    });

    this.releaseSlotBestEffort(intent.slotId);

    return {
      intent: updated,
      status: updated.status,
      buyerId: intent.customerId,
      supplierId: intent.professional,
      forfeitAmountCents,
      strikeId: strikeOutcome.strike.id,
      autoSuspended: strikeOutcome.autoSuspended,
      reason: normalizedReason,
    };
  }

  createIntentTraced(
    input: CreateBookingIntentInput,
    actor: AuthContext,
  ): Promise<BookingIntentRecord> {
    return withSpan("bookingIntents.create", { route: "POST /api/v1/booking-intents" }, () =>
      this.createIntent(input, actor),
    );
  }
}

export const SLOT_ID_PATTERN =
  /^slot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCreateBookingIntentBody(
  body: unknown,
): CreateBookingIntentInput | CreateRecurringBookingInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BookingIntentError(400, "Booking intent payload must be a JSON object.");
  }

  const { slotId, note, rrule, bookingType, holdDeadlineMs, buyerCurrency } = body as {
    slotId?: unknown;
    note?: unknown;
    rrule?: unknown;
    bookingType?: unknown;
    holdDeadlineMs?: unknown;
    buyerCurrency?: unknown;
  };

  let parsedBuyerCurrency: import("../../utils/amount.js").SupportedCurrencies | undefined;
  if (buyerCurrency !== undefined) {
    if (
      typeof buyerCurrency !== "string" ||
      !["USD", "EUR", "GBP", "XLM"].includes(buyerCurrency)
    ) {
      throw new BookingIntentError(
        400,
        "Invalid buyerCurrency. Must be one of USD, EUR, GBP, XLM.",
      );
    }
    parsedBuyerCurrency = buyerCurrency as import("../../utils/amount.js").SupportedCurrencies;
  }

  let parsedBookingType: BookingType | undefined;
  if (bookingType !== undefined) {
    if (bookingType === "standard" || bookingType === "refundable_hold") {
      parsedBookingType = bookingType;
    } else {
      throw new BookingIntentError(400, "Invalid bookingType.");
    }
  }

  let parsedHoldDeadlineMs: number | undefined;
  if (holdDeadlineMs !== undefined) {
    if (typeof holdDeadlineMs !== "number" || Number.isNaN(holdDeadlineMs)) {
      throw new BookingIntentError(400, "holdDeadlineMs must be a valid number.");
    }
    parsedHoldDeadlineMs = holdDeadlineMs;
  }

  // If an RRULE is provided, treat this as a recurring booking request
  if (rrule !== undefined) {
    if (typeof rrule !== "string" || rrule.trim().length === 0) {
      throw new BookingIntentError(400, "rrule must be a non-empty string.");
    }
    const normalizedRRule = rrule.trim();
    // Assert error for ambiguous inputs without explicit offset. Line-based
    // parsing is linear (avoids a backtracking regex on attacker-controlled
    // rrule text).
    const dtstartLine = normalizedRRule.split(/\r?\n/).find((line) => line.startsWith("DTSTART"));
    if (dtstartLine) {
      const valueStart = dtstartLine.indexOf(":");
      const dtstartVal = valueStart >= 0 ? dtstartLine.slice(valueStart + 1) : "";
      const hasZ = dtstartVal.endsWith("Z");
      const hasTzid = normalizedRRule.includes("TZID=");
      if (!hasZ && !hasTzid) {
        throw new BookingIntentError(
          400,
          "Ambiguous DTSTART: missing explicit timezone offset (Z or TZID)",
        );
      }
    }

    let sanitizedNote: string | undefined;
    if (note !== undefined) {
      if (typeof note !== "string") {
        throw new BookingIntentError(400, "note must be a string when provided.");
      }
      sanitizedNote = sanitizeNote(note) ?? undefined;
      if (sanitizedNote === null || sanitizedNote === undefined) {
        throw new BookingIntentError(400, "note cannot be empty when provided.");
      }
      if (sanitizedNote.length > 500) {
        throw new BookingIntentError(400, "note must be 500 characters or fewer.");
      }
    }

    return {
      rrule: normalizedRRule,
      note: sanitizedNote,
      bookingType: parsedBookingType,
      holdDeadlineMs: parsedHoldDeadlineMs,
      buyerCurrency: parsedBuyerCurrency,
    };
  }

  if (typeof slotId !== "string" || slotId.trim().length === 0) {
    throw new BookingIntentError(400, "slotId is required.");
  }

  const normalizedSlotId = slotId.trim();
  if (!SLOT_ID_PATTERN.test(normalizedSlotId)) {
    throw new BookingIntentError(400, "slotId format is invalid.");
  }

  let sanitizedNote: string | undefined;
  if (note !== undefined) {
    if (typeof note !== "string") {
      throw new BookingIntentError(400, "note must be a string when provided.");
    }
    sanitizedNote = sanitizeNote(note) ?? undefined;
    if (sanitizedNote === null || sanitizedNote === undefined) {
      throw new BookingIntentError(400, "note cannot be empty when provided.");
    }
    if (sanitizedNote.length > 500) {
      throw new BookingIntentError(400, "note must be 500 characters or fewer.");
    }
  }

  return {
    slotId: normalizedSlotId,
    note: sanitizedNote,
    bookingType: parsedBookingType,
    holdDeadlineMs: parsedHoldDeadlineMs,
    buyerCurrency: parsedBuyerCurrency,
  };
}
