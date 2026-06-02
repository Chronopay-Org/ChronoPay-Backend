export type BookingIntentStatus = "pending" | "confirmed" | "cancelled" | "expired";

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
  /** Pricing snapshot — present when a pricing strategy was applied at intent creation. */
  pricingStrategyId?: string;
  /** The resolved price at the time the intent was created. */
  resolvedPrice?: number;
  /** Raw inputs used to compute the price (snapshotted for auditability). */
  pricingSnapshot?: {
    basePrice: number;
    slotStartTime: number;
    nowMs: number;
    activeIntentCount: number;
  };
}


export interface BookingIntentRepository {
  create(intent: Omit<BookingIntentRecord, "id">): Promise<BookingIntentRecord>;
  findById(id: string): BookingIntentRecord | undefined;
  findBySlotId(slotId: string): BookingIntentRecord | undefined;
  findBySlotIdAndCustomer(slotId: string, customerId: string): BookingIntentRecord | undefined;
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
