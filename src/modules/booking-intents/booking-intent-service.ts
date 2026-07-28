import type { AuthContext } from "../../middleware/auth.js";
import type { SlotRepository } from "../slots/slot-repository.js";
import type {
  BookingIntentRecord,
  BookingIntentRepository,
  PricingSnapshot,
  BookingType,
  SupplierHoldPolicy,
  RefundMetadata,
} from "./booking-intent-repository.js";
import {
  DEFAULT_SUPPLIER_HOLD_POLICY as DEFAULT_POLICY,
} from "./booking-intent-repository.js";
import { SchedulingService, SlotExpiredError } from "../../services/schedulingService.js";
import { withSpan } from "../../tracing/hooks.js";
import { AppError } from "../../errors/AppError.js";
import { ERROR_CODES } from "../../errors/errorCodes.js";
import { sanitizeNote } from "../../utils/redact.js";
import { resolvePrice } from "../../services/pricingStrategy.js";
import { CancellationPolicyService, RefundBreakdown } from "../../services/cancellationPolicy.js";

export interface CreateBookingIntentInput {
  slotId: string;
  note?: string;
  pricingStrategyId?: StrategyId;
  basePrice?: number;
  bookingType?: BookingType;
  holdDeadlineMs?: number;
}

export interface CreateRecurringBookingInput {
  rrule: string;
  note?: string;
  bookingType?: BookingType;
  holdDeadlineMs?: number;
}

export interface AutoRefundResult {
  intentId: string;
  success: boolean;
  refundedAmountCents: number;
  error?: string;
}

export interface SupplierPolicies {
  getHoldPolicy(professionalId: string): SupplierHoldPolicy;
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
  constructor(
    private readonly bookingIntentRepository: BookingIntentRepository,
    private readonly slotRepository: SlotRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly nowMs: () => number = () => Date.now(),
    private readonly supplierPolicies: SupplierPolicies = {
      getHoldPolicy: () => DEFAULT_POLICY,
    },
  ) {}

  private get schedulingService(): SchedulingService {
    return new SchedulingService(this.slotRepository, this.bookingIntentRepository);
  }

  private resolveHoldDeadline(
    slot: { professional: string; startTime: number },
    inputHoldDeadlineMs?: number,
  ): number {
    const policy = this.supplierPolicies.getHoldPolicy(slot.professional);
    const now = this.nowMs();

    let deadlineMs: number;
    if (inputHoldDeadlineMs !== undefined && policy.allowPerSlotOverride) {
      const clamped = Math.max(
        policy.minimumHoldDeadlineMs,
        Math.min(policy.maximumHoldDeadlineMs, inputHoldDeadlineMs),
      );
      deadlineMs = now + clamped;
    } else {
      deadlineMs = now + policy.defaultHoldDeadlineMs;
    }

    if (slot.startTime > 0 && deadlineMs > slot.startTime) {
      deadlineMs = slot.startTime;
    }

    return deadlineMs;
  }

  private resolveIntentPrice(intent: BookingIntentRecord): number {
    return intent.pricingSnapshot?.resolvedPrice ?? 0;
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
      const activeBookings = this.bookingIntentRepository
        .listAll()
        .filter(
          (i) =>
            i.slotId === slot.id &&
            (i.status === "pending" || i.status === "confirmed" || i.status === "hold_placed"),
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

    const bookingType: BookingType = input.bookingType ?? "standard";
    const isRefundableHold = bookingType === "refundable_hold";
    const status = isRefundableHold ? "hold_placed" : "pending";
    const holdUntilMs = isRefundableHold
      ? this.resolveHoldDeadline(slot, input.holdDeadlineMs)
      : undefined;
    const holdPlacedAt = isRefundableHold ? this.now() : undefined;

    const intent = this.bookingIntentRepository.create({
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
    });

    this.schedulingService.reserveSlot(input.slotId);

    return intent;
  }

  async createRecurringIntents(
    input: CreateRecurringBookingInput,
    actor: AuthContext,
  ): Promise<{ successes: BookingIntentRecord[]; failures: { date: string; reason: string }[] }> {
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

      const existingForCustomer = await this.bookingIntentRepository.findBySlotIdAndCustomer(
        slot.id,
        actor.userId,
      );
      if (existingForCustomer) {
        failures.push({
          date: occ.toISOString(),
          reason: "Customer already has an intent for this slot",
        });
        continue;
      }

      const existingForSlot = await this.bookingIntentRepository.findBySlotId(slot.id);
      if (existingForSlot) {
        failures.push({
          date: occ.toISOString(),
          reason: "Slot already has active booking intent",
        });
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

  cancelIntent(intentId: string, actor: AuthContext): BookingIntentRecord {
    const intent = this.bookingIntentRepository.findById(intentId);
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

    const updated = this.bookingIntentRepository.update(intentId, updates);

    this.schedulingService.releaseSlot(intent.slotId);

    return updated;
  }

  previewCancel(intentId: string, actor: AuthContext): RefundBreakdown {
    const intent = this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (intent.customerId !== actor.userId && actor.role !== "admin") {
      throw new BookingIntentError(
        403,
        "You are not authorized to preview cancel this booking intent.",
      );
    }

    if (intent.bookingType === "refundable_hold" && intent.status === "hold_placed") {
      const fullAmount = this.resolveIntentPrice(intent);
      return {
        refundAmountCents: fullAmount,
        feeAmountCents: 0,
        totalPaidCents: fullAmount,
        policyApplied: "refundable_hold_full_refund",
      };
    }

    const policy = new CancellationPolicyService();
    return policy.calculateRefund(intent);
  }

  expireIntent(intentId: string): BookingIntentRecord {
    const intent = this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    const canExpire = intent.status === "pending" || intent.status === "hold_placed";
    if (!canExpire) {
      throw new BookingIntentError(409, `Cannot expire intent with status "${intent.status}".`);
    }

    const updated = this.bookingIntentRepository.updateStatus(intentId, "expired");

    this.schedulingService.releaseSlot(intent.slotId);

    return updated;
  }

  autoRefundHold(intentId: string): BookingIntentRecord {
    const intent = this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (intent.bookingType !== "refundable_hold") {
      throw new BookingIntentError(409, `Intent "${intentId}" is not a refundable hold.`);
    }

    if (intent.status !== "hold_placed") {
      throw new BookingIntentError(
        409,
        `Cannot auto-refund intent with status "${intent.status}".`,
      );
    }

    const nowMs = this.nowMs();
    if (intent.holdUntilMs !== undefined && intent.holdUntilMs > nowMs) {
      throw new BookingIntentError(
        409,
        `Hold deadline has not yet passed (${new Date(intent.holdUntilMs).toISOString()}).`,
      );
    }

    const refundAmount = this.resolveIntentPrice(intent);

    const updated = this.bookingIntentRepository.update(intentId, {
      status: "auto_refunded",
      refundedAt: this.now(),
      refundMetadata: {
        refundedAt: this.now(),
        refundedAmountCents: refundAmount,
        refundReason: "deadline_missed",
      },
    });

    this.schedulingService.releaseSlot(intent.slotId);

    return updated;
  }

  processExpiredHolds(): AutoRefundResult[] {
    const expired = this.bookingIntentRepository.findExpiredHolds(this.nowMs());
    const results: AutoRefundResult[] = [];

    for (const intent of expired) {
      try {
        const refunded = this.autoRefundHold(intent.id);
        results.push({
          intentId: refunded.id,
          success: true,
          refundedAmountCents: refunded.refundMetadata?.refundedAmountCents ?? 0,
        });
      } catch (err) {
        results.push({
          intentId: intent.id,
          success: false,
          refundedAmountCents: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  getHoldStatus(
    intentId: string,
    actor: AuthContext,
  ): {
    holdUntilMs: number | undefined;
    remainingMs: number;
    holdPlacedAt: string | undefined;
    isPastDeadline: boolean;
    refundableAmountCents: number;
  } {
    const intent = this.bookingIntentRepository.findById(intentId);
    if (!intent) {
      throw new BookingIntentError(404, "Booking intent not found.");
    }

    if (
      intent.customerId !== actor.userId &&
      actor.role !== "admin" &&
      intent.professional !== actor.userId
    ) {
      throw new BookingIntentError(403, "You are not authorized to view this booking intent.");
    }

    const nowMs = this.nowMs();
    const holdUntilMs = intent.holdUntilMs;
    const remainingMs = holdUntilMs !== undefined ? Math.max(0, holdUntilMs - nowMs) : 0;

    return {
      holdUntilMs,
      remainingMs,
      holdPlacedAt: intent.holdPlacedAt,
      isPastDeadline: holdUntilMs !== undefined && holdUntilMs <= nowMs,
      refundableAmountCents:
        intent.bookingType === "refundable_hold" ? this.resolveIntentPrice(intent) : 0,
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

const VALID_BOOKING_TYPES = new Set(["standard", "refundable_hold"]);

function parseBookingType(raw: unknown): BookingType | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !VALID_BOOKING_TYPES.has(raw)) {
    throw new BookingIntentError(400, "bookingType must be 'standard' or 'refundable_hold'.");
  }
  return raw as BookingType;
}

function parseHoldDeadlineMs(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new BookingIntentError(400, "holdDeadlineMs must be a positive number of milliseconds.");
  }
  return raw;
}

export function parseCreateBookingIntentBody(
  body: unknown,
): CreateBookingIntentInput | CreateRecurringBookingInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BookingIntentError(400, "Booking intent payload must be a JSON object.");
  }

  const { slotId, note, rrule, bookingType, holdDeadlineMs } = body as {
    slotId?: unknown;
    note?: unknown;
    rrule?: unknown;
    bookingType?: unknown;
    holdDeadlineMs?: unknown;
  };

  const parsedBookingType = parseBookingType(bookingType);
  const parsedHoldDeadlineMs = parseHoldDeadlineMs(holdDeadlineMs);

  if (rrule !== undefined) {
    if (typeof rrule !== "string" || rrule.trim().length === 0) {
      throw new BookingIntentError(400, "rrule must be a non-empty string.");
    }
    const normalizedRRule = rrule.trim();

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
  };
}
