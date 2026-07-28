import type { StrategyId, StrategyConfig } from "../../services/pricingStrategy.js";
import type { HoldFeePolicySnapshot } from "../../services/holdFeePolicy.js";

export type BookingIntentStatus = "pending" | "confirmed" | "firm" | "cancelled" | "expired";

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
  pricingSnapshot?: PricingSnapshot;
  cancellationPolicySnapshot?: CancellationPolicySnapshot;
  holdFeePolicySnapshot?: HoldFeePolicySnapshot;
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
}

export class InMemoryBookingIntentRepository implements BookingIntentRepository {
  private readonly intents: BookingIntentRecord[] = [];
  private sequence = 1;

  async create(intent: Omit<BookingIntentRecord, "id">): Promise<BookingIntentRecord> {
    const created: BookingIntentRecord = {
      id: `intent-${this.sequence++}`,
      ...intent,
    };
    this.intents.push(created);
    return { ...created };
  }

  findBySlotId(slotId: string): BookingIntentRecord | undefined {
    const intent = this.intents.find(
      (entry) => entry.slotId === slotId && entry.status === "pending",
    );
    return intent ? { ...intent } : undefined;
  }

  findBySlotIdAndCustomer(slotId: string, customerId: string): BookingIntentRecord | undefined {
    const intent = this.intents.find(
      (entry) => entry.slotId === slotId && entry.customerId === customerId && entry.status === "pending",
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
}
