export interface BookingIntentRecord {
  id: string;
  slotId: string;
  professional: string;
  customerId: string;
  startTime: number;
  endTime: number;
  status: "pending";
  note?: string;
  createdAt: string;
}


export interface BookingIntentRepository {
  create(intent: Omit<BookingIntentRecord, "id">): BookingIntentRecord;
  findBySlotId(slotId: string): BookingIntentRecord | undefined;
  findBySlotIdAndCustomer(slotId: string, customerId: string): BookingIntentRecord | undefined;
  findById(id: string): BookingIntentRecord | undefined;
  listByCustomer(customerId: string): BookingIntentRecord[];
  listAll(): BookingIntentRecord[];
}

export class InMemoryBookingIntentRepository implements BookingIntentRepository {
  private readonly intents: BookingIntentRecord[] = [];
  private sequence = 1;

  create(intent: Omit<BookingIntentRecord, "id">): BookingIntentRecord {
    const created: BookingIntentRecord = {
      id: `intent-${this.sequence++}`,
      ...intent,
    };

    this.intents.push(created);
    return { ...created };
  }

  findBySlotId(slotId: string): BookingIntentRecord | undefined {
    const intent = this.intents.find((entry) => entry.slotId === slotId);
    return intent ? { ...intent } : undefined;
  }

  findBySlotIdAndCustomer(slotId: string, customerId: string): BookingIntentRecord | undefined {
    const intent = this.intents.find(
      (entry) => entry.slotId === slotId && entry.customerId === customerId,
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
}
