export type BuyerTier = "bronze" | "silver" | "gold" | "platinum";

export interface DisputeQueueItem {
  disputeId: string;
  amount: number;
  buyerTier: BuyerTier;
  createdAt: number;
  queuedAt: number;
  score?: number;
  id?: string;
}

export interface QueueDashboard {
  total: number;
  depthByTier: Record<BuyerTier, number>;
  next: DisputeQueueItem | null;
}

const TIER_WEIGHTS: Record<BuyerTier, number> = {
  bronze: 1,
  silver: 2,
  gold: 3,
  platinum: 4,
};

const AGE_WEIGHT_PER_MINUTE = 0.05;

export class DisputeArbitrationQueueService {
  private readonly items: DisputeQueueItem[] = [];

  enqueueDispute(item: Omit<DisputeQueueItem, "score" | "disputeId"> & { disputeId?: string; id?: string }): DisputeQueueItem {
    const disputeId = item.disputeId ?? item.id ?? "dispute-queue-item";
    const queueItem: DisputeQueueItem = {
      ...item,
      disputeId,
      score: this.computeScore(item, item.queuedAt),
    };
    this.items.push(queueItem);
    return queueItem;
  }

  updateTier(disputeId: string, buyerTier: BuyerTier): void {
    const item = this.items.find((entry) => entry.disputeId === disputeId);
    if (item) {
      item.buyerTier = buyerTier;
      item.score = this.computeScore(item, item.queuedAt);
    }
  }

  removeDispute(disputeId: string): void {
    const index = this.items.findIndex((entry) => entry.disputeId === disputeId);
    if (index >= 0) {
      this.items.splice(index, 1);
    }
  }

  /** Remove all disputes from the queue (useful for test isolation). */
  clear(): void {
    this.items.length = 0;
  }

  reindex(now: number): DisputeQueueItem[] {
    for (const item of this.items) {
      item.score = this.computeScore(item, now);
    }
    return this.list(now);
  }

  list(now: number): DisputeQueueItem[] {
    return this.items
      .map((item) => ({ ...item, score: this.computeScore(item, now) }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return (right.score ?? 0) - (left.score ?? 0);
        }
        return left.queuedAt - right.queuedAt;
      });
  }

  getDashboard(now: number): QueueDashboard {
    const ordered = this.list(now);
    const depthByTier: Record<BuyerTier, number> = {
      bronze: 0,
      silver: 0,
      gold: 0,
      platinum: 0,
    };

    for (const item of ordered) {
      depthByTier[item.buyerTier] += 1;
    }

    return {
      total: ordered.length,
      depthByTier,
      next: ordered[0] ?? null,
    };
  }

  private computeScore(item: Pick<DisputeQueueItem, "amount" | "buyerTier" | "queuedAt">, now: number): number {
    const ageMinutes = Math.max(0, Math.floor((now - item.queuedAt) / 60_000));
    return item.amount * 0.001 + TIER_WEIGHTS[item.buyerTier] * 10 + ageMinutes * AGE_WEIGHT_PER_MINUTE;
  }
}
