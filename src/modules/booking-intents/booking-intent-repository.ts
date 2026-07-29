import type { StrategyId, StrategyConfig } from "../../services/pricingStrategy.js";

export type BookingIntentStatus = "pending" | "confirmed" | "firm" | "cancelled" | "expired";

/**
 * Immutable snapshot of the pricing inputs and result captured at intent
 * creation time.  Stored for auditability — the resolved price never changes
 * even if the slot's strategy is later updated.
 */
export interface PricingSnapshot {
  /** Strategy that produced the price. */
  strategyId: StrategyId;
  /** Resolved price at the moment the intent was created. */
  resolvedPrice: number;
  /** Base price used as input. */
  basePrice: number;
  /** Slot start time (ms) used as input. */
  slotStartMs: number;
  /** "now" timestamp (ms) used as input. */
  nowMs: number;
  /** Active bookings count used as input. */
  activeBookings: number;
  /** Capacity used as input. */
  capacity: number;
  /** Strategy-specific config used as input. */
  config: StrategyConfig;
}

export interface CancellationPolicyVersion {
  /** Semantic version string identifying the policy (e.g. "v1-timezone-tier", "v2-prorated") */
  versionId: string;
  /** ISO 8601 timestamp when this policy became active */
  effectiveFrom: string;
  /** Optional ISO 8601 timestamp when this policy was superseded (undefined = current) */
  effectiveUntil?: string;
  /** Human-readable description of the policy terms */
  description: string;
}

export interface CancellationPolicySnapshot {
  /** Version ID of the cancellation policy captured at booking time */
  policyVersionId: string;
  /** Snapshot of the policy terms for auditability */
  policyTerms: ProratedCancellationTerms;
  /** "now" timestamp (ms) when the snapshot was captured */
  capturedAtMs: number;
}

export interface ProratedCancellationTerms {
  /** Cancellation fee tiers keyed by hours-until-start (inclusive floor) */
  tiers: {
    /** Minimum hours until start for this tier */
    minHoursUntilStart: number;
    /** Optional maximum hours until start (exclusive). Undefined = unbounded upper end */
    maxHoursUntilStart?: number;
    /** Ratio (0–1) of the base price that is REFUNDED in this tier */
    refundRatio: number;
    /** Flat cancellation fee (smallest currency unit) deducted from base refund */
    flatFee?: number;
    /** Percentage fee (0–1) of the base refund, e.g. 0.05 = 5% */
    percentageFee?: number;
    /** Tax reversal ratio (0–1) applied to the base refund */
    taxReversalRatio?: number;
  }[];
  /** Minimum refund (smallest currency unit). Caps lower bound. */
  minRefundAmount?: number;
  /** Maximum refund (smallest currency unit). Caps upper bound. */
  maxRefundAmount?: number;
}

export interface BookingIntentRecord {
  id: string;
  slotId: string;
  professional: string;
  customerId: string;
  startTime: number;
  endTime: number;
  status: BookingIntentStatus;
  note?: string;
  tokenAsset?: string;
  mintTxHash?: string;
  createdAt: string;
  bookingType: BookingType;
  holdUntilMs?: number;
  holdPlacedAt?: string;
  refundedAt?: string;
  refundMetadata?: RefundMetadata;
  pricingSnapshot?: PricingSnapshot;
  /**
   * Cancellation policy version captured at booking creation time.
   * Used for grandfathering — cancellations always apply the policy version
   * that was active when the booking was made, even if the policy is later
   * updated.
   */
  cancellationPolicySnapshot?: CancellationPolicySnapshot;
}

export interface BookingIntentRepository {
  create(intent: Omit<BookingIntentRecord, "id">): Promise<BookingIntentRecord>;
  findById(id: string): BookingIntentRecord | undefined;
  findBySlotId(slotId: string): BookingIntentRecord | undefined;
  findBySlotIdAndCustomer(slotId: string, customerId: string): BookingIntentRecord | undefined;
  findLatestBySlotId?(slotId: string): BookingIntentRecord | undefined;
  listByCustomer(customerId: string): BookingIntentRecord[];
  listAll(): BookingIntentRecord[];
  updateStatus(id: string, status: BookingIntentStatus): BookingIntentRecord;
  update(id: string, updates: Partial<Omit<BookingIntentRecord, "id">>): BookingIntentRecord;
  findExpiredHolds(nowMs: number): BookingIntentRecord[];
}

const ACTIVE_HOLD_STATUSES: BookingIntentStatus[] = ["pending", "hold_placed"];

export class InMemoryBookingIntentRepository implements BookingIntentRepository {
  private readonly intents: BookingIntentRecord[] = [];
  private sequence = 1;

  async create(intent: Omit<BookingIntentRecord, "id">): Promise<BookingIntentRecord> {
    const created: BookingIntentRecord = {
      id: `intent-${this.sequence++}`,
      bookingType: "standard",
      ...intent,
    };

    this.intents.push(created);
    return { ...created };
  }

  findBySlotId(slotId: string): BookingIntentRecord | undefined {
    const intent = this.intents.find(
      (entry) => entry.slotId === slotId && ACTIVE_HOLD_STATUSES.includes(entry.status),
    );
    return intent ? { ...intent } : undefined;
  }

  findBySlotIdAndCustomer(slotId: string, customerId: string): BookingIntentRecord | undefined {
    const intent = this.intents.find(
      (entry) =>
        entry.slotId === slotId &&
        entry.customerId === customerId &&
        ACTIVE_HOLD_STATUSES.includes(entry.status),
    );
    return intent ? { ...intent } : undefined;
  }

  findLatestBySlotId(slotId: string): BookingIntentRecord | undefined {
    const candidates = this.intents.filter((entry) => entry.slotId === slotId);
    if (candidates.length === 0) return undefined;
    return candidates.reduce((latest, current) =>
      current.startTime > latest.startTime ? current : latest,
    );
  }

  findById(id: string): BookingIntentRecord | undefined {
    const intent = this.intents.find((entry) => entry.id === id);
    return intent ? { ...intent } : undefined;
  }

  listByCustomer(customerId: string): BookingIntentRecord[] {
    return this.intents.filter((entry) => entry.customerId === customerId).map((i) => ({ ...i }));
  }

  listAll(): BookingIntentRecord[] {
    return this.intents.map((i) => ({ ...i }));
  }

  updateStatus(id: string, status: BookingIntentStatus): BookingIntentRecord {
    const index = this.intents.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw new Error(`BookingIntent with id "${id}" not found`);
    }
    this.intents[index] = { ...this.intents[index], status };
    return { ...this.intents[index] };
  }

  update(id: string, updates: Partial<Omit<BookingIntentRecord, "id">>): BookingIntentRecord {
    const index = this.intents.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw new Error(`BookingIntent with id "${id}" not found`);
    }
    this.intents[index] = { ...this.intents[index], ...updates };
    return { ...this.intents[index] };
  }

  findExpiredHolds(nowMs: number): BookingIntentRecord[] {
    return this.intents
      .filter(
        (entry) =>
          entry.bookingType === "refundable_hold" &&
          entry.status === "hold_placed" &&
          entry.holdUntilMs !== undefined &&
          entry.holdUntilMs <= nowMs,
      )
      .map((i) => ({ ...i }));
  }
}
