export type BookingIntentStatus = "pending" | "cancelled" | "expired";

export interface BookingIntentRecord {
  id: string;
  slotId: string;
  professional: string;
  customerId: string;
  startTime: number;
  endTime: number;
  status: BookingIntentStatus;
  note?: string;
  createdAt: string;
}

export interface BookingIntentRepository {
  create(intent: Omit<BookingIntentRecord, "id">): BookingIntentRecord;
  findById(id: string): BookingIntentRecord | undefined;
  findBySlotId(slotId: string): BookingIntentRecord | undefined;
  findBySlotIdAndCustomer(slotId: string, customerId: string): BookingIntentRecord | undefined;
  updateStatus(id: string, status: BookingIntentStatus): BookingIntentRecord;
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
    const intent = this.intents.find(
      (entry) => entry.slotId === slotId && entry.status === "pending",
    );
    return intent ? { ...intent } : undefined;
  }

  findBySlotIdAndCustomer(slotId: string, customerId: string): BookingIntentRecord | undefined {
    const intent = this.intents.find(
      (entry) =>
        entry.slotId === slotId &&
        entry.customerId === customerId &&
        entry.status === "pending",
    );
    return intent ? { ...intent } : undefined;
  }

  findById(id: string): BookingIntentRecord | undefined {
    const intent = this.intents.find((entry) => entry.id === id);
    return intent ? { ...intent } : undefined;
  }

  updateStatus(id: string, status: BookingIntentStatus): BookingIntentRecord {
    const index = this.intents.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw new Error(`Booking intent ${id} not found`);
    }
    this.intents[index] = { ...this.intents[index], status };
    return { ...this.intents[index] };
  }
}
