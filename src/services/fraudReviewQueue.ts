import { logger } from "../utils/logger.js";

export interface HitlReviewItem {
  id: string;
  intentId: string;
  score: number;
  reasons: string[];
  status: 'pending' | 'approved' | 'rejected' | 'referred';
  slaBreachAt: number;
  createdAt: number;
  operatorId?: string;
  decisionNotes?: string;
}

class FraudReviewQueue {
  private queue = new Map<string, HitlReviewItem>();
  // Feature store mock
  private featureStoreLog: any[] = [];
  // 15 minutes default SLA
  private slaDurationMs = Number(process.env.FRAUD_HITL_SLA_MS) || 15 * 60 * 1000;

  enqueue(intentId: string, score: number, reasons: string[]): HitlReviewItem {
    const id = `hitl-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const item: HitlReviewItem = {
      id,
      intentId,
      score,
      reasons,
      status: 'pending',
      createdAt: Date.now(),
      slaBreachAt: Date.now() + this.slaDurationMs,
    };
    this.queue.set(id, item);
    return item;
  }

  getPendingItems(): HitlReviewItem[] {
    return Array.from(this.queue.values()).filter(item => item.status === 'pending');
  }

  getItem(id: string): HitlReviewItem | undefined {
    return this.queue.get(id);
  }

  decide(id: string, operatorId: string, decision: 'approved' | 'rejected' | 'referred', notes?: string): HitlReviewItem {
    const item = this.queue.get(id);
    if (!item) throw new Error("Review item not found");
    if (item.status !== 'pending') throw new Error("Item already decided");

    item.status = decision;
    item.operatorId = operatorId;
    item.decisionNotes = notes;

    const slaBreached = Date.now() > item.slaBreachAt;
    
    // Emit labeled outcome to feature store for model retraining
    this.emitToFeatureStore({
      intentId: item.intentId,
      score: item.score,
      reasons: item.reasons,
      outcome: decision,
      operatorId,
      notes,
      slaBreached,
      decidedAt: Date.now()
    });

    return item;
  }

  private emitToFeatureStore(record: any) {
    this.featureStoreLog.push(record);
    logger.info({ featureStoreRecord: record }, "Emitted labeled outcome to feature store");
  }

  getFeatureStoreLog(): any[] {
    return this.featureStoreLog;
  }

  _reset(): void {
    this.queue.clear();
    this.featureStoreLog = [];
  }
}

export const fraudReviewQueue = new FraudReviewQueue();
