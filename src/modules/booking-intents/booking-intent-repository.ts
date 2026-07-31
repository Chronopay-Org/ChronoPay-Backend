import type { StrategyId, StrategyConfig } from "../../services/pricingStrategy.js";
import type { HoldFeePolicySnapshot } from "../../services/holdFeePolicy.js";

export type BookingIntentStatus =
  | "pending"
  | "confirmed"
  | "firm"
  | "cancelled"
  | "expired"
  | "hold_placed"
  | "hold_refunded";

export type BookingType = "standard" | "refundable_hold";

export interface PricingSnapshot {
  strategyId: StrategyId;
  resolvedPrice: number;
  basePrice: number;
  slotStartMs: number;
  nowMs: number;
  activeBookings: number;
  capacity: number;
  config: StrategyConfig;
}

export interface CancellationPolicyVersion {
  versionId: string;
  effectiveFrom: string;
  effectiveUntil?: string;
  description: string;
}

export interface CancellationPolicySnapshot {
  policyVersionId: string;
  policyTerms: ProratedCancellationTerms;
  capturedAtMs: number;
}

export interface ProratedCancellationTerms {
  tiers: {
    minHoursUntilStart: number;
    maxHoursUntilStart?: number;
    refundRatio: number;
    flatFee?: number;
    percentageFee?: number;
    taxReversalRatio?: number;
  }[];
  minRefundAmount?: number;
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
  slotIds?: string[];
  bundleId?: string;
  supplierId?: string;
  buyerId?: string;
  escrowHoldId?: string;
  bookingType?: BookingType;
  holdUntilMs?: number;
  holdPlacedAt?: string;
  refundedAt?: string;
  refundMetadata?: {
    refundedAt: string;
    refundedAmountCents: number;
    refundReason: string;
  };
  pricingSnapshot?: PricingSnapshot;
  cancellationPolicySnapshot?: CancellationPolicySnapshot;
  holdFeePolicySnapshot?: HoldFeePolicySnapshot;
}

export interface BookingIntentRepository {
  create(intent: Omit<BookingIntentRecord, "id">): Promise<BookingIntentRecord> | BookingIntentRecord;
  findById(id: string): BookingIntentRecord | undefined | Promise<BookingIntentRecord | undefined>;
  findBySlotId(slotId: string): BookingIntentRecord | undefined | Promise<BookingIntentRecord | undefined>;
  findBySlotIdAndCustomer(slotId: string, customerId: string): BookingIntentRecord | undefined | Promise<BookingIntentRecord | undefined>;
  findLatestBySlotId?(slotId: string): BookingIntentRecord | undefined | Promise<BookingIntentRecord | undefined>;
  listByCustomer(customerId: string): BookingIntentRecord[] | Promise<BookingIntentRecord[]>;
  listAll(): BookingIntentRecord[] | Promise<BookingIntentRecord[]>;
  updateStatus(id: string, status: BookingIntentStatus): BookingIntentRecord | Promise<BookingIntentRecord>;
  update(id: string, updates: Partial<Omit<BookingIntentRecord, "id">>): BookingIntentRecord | Promise<BookingIntentRecord>;
  updateTokenInfo?(id: string, tokenAsset: string, mintTxHash: string): Promise<void> | void;
  findExpiredHolds(nowMs: number): BookingIntentRecord[] | Promise<BookingIntentRecord[]>;
  /**
   * Returns up to `limit` intents stuck in `pending` whose `createdAt` is at or
   * before `cutoffMs`, oldest first. Used by the expire-booking-intents worker.
   * PostgreSQL implementations should claim rows with `FOR UPDATE SKIP LOCKED`
   * so concurrent worker instances never process the same intent twice.
   */
  findStalePendingIntents(cutoffMs: number, limit: number): BookingIntentRecord[] | Promise<BookingIntentRecord[]>;
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

  updateTokenInfo(id: string, tokenAsset: string, mintTxHash: string): void {
    const index = this.intents.findIndex((entry) => entry.id === id);
    if (index !== -1) {
      this.intents[index] = {
        ...this.intents[index],
        tokenAsset,
        mintTxHash,
      };
    }
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

  findStalePendingIntents(cutoffMs: number, limit: number): BookingIntentRecord[] {
    return this.intents
      .filter(
        (entry) =>
          entry.status === "pending" &&
          new Date(entry.createdAt).getTime() <= cutoffMs,
      )
      .sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
      .slice(0, limit)
      .map((i) => ({ ...i }));
  }
}
