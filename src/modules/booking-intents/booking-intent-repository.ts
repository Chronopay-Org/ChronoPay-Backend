import type { StrategyId, StrategyConfig } from "../../services/pricingStrategy.js";

export type BookingType = "standard" | "refundable_hold";
export type BookingIntentStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "expired"
  | "hold_placed"
  | "hold_refunded"
  | "auto_refunded";

export interface SupplierHoldPolicy {
  defaultHoldDeadlineMs: number;
  allowPerSlotOverride: boolean;
  minimumHoldDeadlineMs: number;
  maximumHoldDeadlineMs: number;
}

export const DEFAULT_SUPPLIER_HOLD_POLICY: SupplierHoldPolicy = {
  defaultHoldDeadlineMs: 24 * 60 * 60 * 1000,
  allowPerSlotOverride: true,
  minimumHoldDeadlineMs: 15 * 60 * 1000,
  maximumHoldDeadlineMs: 7 * 24 * 60 * 60 * 1000,
};

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

export interface RefundMetadata {
  refundedAt: string;
  refundedAmountCents: number;
  refundReason: "customer_cancel" | "deadline_missed" | "supplier_cancel" | "admin_action";
  refundTxHash?: string;
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
