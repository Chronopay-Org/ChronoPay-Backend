export type BookingIntentStatus = "pending" | "completed" | "expired" | "cancelled";

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
}

export interface BookingIntentRepository {
  create(intent: Omit<BookingIntentRecord, "id">): Promise<BookingIntentRecord>;
  findById(id: string): Promise<BookingIntentRecord | undefined>;
  findBySlotId(slotId: string): Promise<BookingIntentRecord | undefined>;
  findBySlotIdAndCustomer(slotId: string, customerId: string): Promise<BookingIntentRecord | undefined>;
  updateTokenInfo(id: string, tokenAsset: string, mintTxHash: string): Promise<void>;
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

  async findBySlotId(slotId: string): Promise<BookingIntentRecord | undefined> {
    const intent = this.intents.find((entry) => entry.slotId === slotId);
    return intent ? { ...intent } : undefined;
  }

  async findBySlotIdAndCustomer(slotId: string, customerId: string): Promise<BookingIntentRecord | undefined> {
    const intent = this.intents.find(
      (entry) => entry.slotId === slotId && entry.customerId === customerId,
    );
    return intent ? { ...intent } : undefined;
  }

  async findById(id: string): Promise<BookingIntentRecord | undefined> {
    const intent = this.intents.find((entry) => entry.id === id);
    return intent ? { ...intent } : undefined;
  }

  async updateTokenInfo(id: string, tokenAsset: string, mintTxHash: string): Promise<void> {
    const index = this.intents.findIndex((entry) => entry.id === id);
    if (index !== -1) {
      this.intents[index].tokenAsset = tokenAsset;
      this.intents[index].mintTxHash = mintTxHash;
    }
  }
}
