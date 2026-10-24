export type SubscriptionStatus = "active" | "paused" | "cancelled";

export interface SubscriptionRecord {
  id: string;
  productId: string;
  subscriberId: string;
  status: SubscriptionStatus;
  nextSlotStartMs: number;
  slotOffsetMs: number;
  slotsMinted: number;
  pausedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRepository {
  create(sub: Omit<SubscriptionRecord, "id" | "createdAt" | "updatedAt">): SubscriptionRecord;
  findById(subId: string): SubscriptionRecord | undefined;
  findByProductAndSubscriber(productId: string, subscriberId: string): SubscriptionRecord | undefined;
  listActiveByProduct(productId: string): SubscriptionRecord[];
  listActiveDueBefore(beforeMs: number, batchSize: number): SubscriptionRecord[];
  update(subId: string, updates: Partial<Omit<SubscriptionRecord, "id" | "createdAt">>): SubscriptionRecord;
}

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private readonly subs: SubscriptionRecord[] = [];
  private sequence = 1;

  create(input: Omit<SubscriptionRecord, "id" | "createdAt" | "updatedAt">): SubscriptionRecord {
    const now = new Date().toISOString();
    const sub: SubscriptionRecord = {
      id: `sub-${this.sequence++}`,
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.subs.push(sub);
    return { ...sub };
  }

  findById(subId: string): SubscriptionRecord | undefined {
    const sub = this.subs.find((s) => s.id === subId);
    return sub ? { ...sub } : undefined;
  }

  findByProductAndSubscriber(productId: string, subscriberId: string): SubscriptionRecord | undefined {
    const sub = this.subs.find(
      (s) =>
        s.productId === productId &&
        s.subscriberId === subscriberId &&
        (s.status === "active" || s.status === "paused"),
    );
    return sub ? { ...sub } : undefined;
  }

  listActiveByProduct(productId: string): SubscriptionRecord[] {
    return this.subs
      .filter((s) => s.productId === productId && s.status === "active")
      .map((s) => ({ ...s }));
  }

  listActiveDueBefore(beforeMs: number, batchSize: number): SubscriptionRecord[] {
    return this.subs
      .filter((s) => s.status === "active" && s.nextSlotStartMs <= beforeMs)
      .sort((a, b) => a.nextSlotStartMs - b.nextSlotStartMs)
      .slice(0, batchSize)
      .map((s) => ({ ...s }));
  }

  update(subId: string, updates: Partial<Omit<SubscriptionRecord, "id" | "createdAt">>): SubscriptionRecord {
    const index = this.subs.findIndex((s) => s.id === subId);
    if (index === -1) {
      throw new Error(`Subscription ${subId} not found`);
    }
    this.subs[index] = {
      ...this.subs[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    return { ...this.subs[index] };
  }
}
