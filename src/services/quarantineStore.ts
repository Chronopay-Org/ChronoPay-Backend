// src/services/quarantineStore.ts
import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";

/** Simple in‑memory store for quarantine intents. */
export class QuarantineStore {
  private readonly store = new Map<string, any>();

  /** Add a new quarantine entry and return its id. */
  add(data: any): string {
    const id = uuidv4();
    this.store.set(id, data);
    return id;
  }

  /** Retrieve an entry by id. */
  get(id: string): any | undefined {
    return this.store.get(id);
  }

  /** Delete an entry. */
  delete(id: string): void {
    this.store.delete(id);
  }
}

export type PayoutQuarantineStatus = "active" | "quarantined" | "released";

export interface PayoutQuarantineEntry {
  payoutId: string;
  supplierId?: string;
  totalFailures: number;
  threshold: number;
  status: PayoutQuarantineStatus;
  lastErrorClass?: string;
  lastErrorMessage?: string;
  quarantinedAt?: string;
  releasedAt?: string;
  quarantineReason?: string;
  releaseReason?: string;
  releasedBy?: string;
}

export interface RecordPayoutFailureInput {
  payoutId: string;
  supplierId?: string;
  errorClass?: string;
  errorMessage?: string;
  threshold?: number;
}

export interface ReleasePayoutQuarantineOptions {
  releasedBy?: string;
  reason?: string;
}

export interface RecordPayoutFailureResult extends PayoutQuarantineEntry {
  quarantined: boolean;
}

export const payoutQuarantineEvents = new EventEmitter();

export class PayoutQuarantineService {
  private readonly failureCounts = new Map<string, number>();
  private readonly quarantineEntries = new Map<string, PayoutQuarantineEntry>();

  constructor(private readonly options: { defaultThreshold?: number } = {}) {}

  recordFailure(input: RecordPayoutFailureInput): RecordPayoutFailureResult {
    const threshold = input.threshold ?? this.options.defaultThreshold ?? 3;
    const totalFailures = (this.failureCounts.get(input.payoutId) ?? 0) + 1;
    this.failureCounts.set(input.payoutId, totalFailures);

    const existing = this.quarantineEntries.get(input.payoutId);
    const now = new Date().toISOString();
    const entry: PayoutQuarantineEntry = {
      payoutId: input.payoutId,
      supplierId: input.supplierId ?? existing?.supplierId,
      totalFailures,
      threshold,
      status: existing?.status === "released" ? "active" : existing?.status ?? "active",
      lastErrorClass: input.errorClass ?? existing?.lastErrorClass,
      lastErrorMessage: input.errorMessage ?? existing?.lastErrorMessage,
      quarantinedAt: existing?.quarantinedAt,
      releasedAt: existing?.releasedAt,
      quarantineReason: existing?.quarantineReason,
      releaseReason: existing?.releaseReason,
      releasedBy: existing?.releasedBy,
    };

    const isQuarantined = threshold <= 0 ? true : totalFailures >= threshold;
    let quarantined = false;

    if (isQuarantined && entry.status !== "quarantined") {
      entry.status = "quarantined";
      entry.quarantinedAt = now;
      entry.quarantineReason = "failure-threshold-reached";
      entry.releasedAt = undefined;
      entry.releaseReason = undefined;
      entry.releasedBy = undefined;
      quarantined = true;
      payoutQuarantineEvents.emit("alert", {
        type: "PAYOUT_QUARANTINED",
        payoutId: input.payoutId,
        supplierId: input.supplierId,
        totalFailures,
        threshold,
        quarantineReason: entry.quarantineReason,
      });
    }

    this.quarantineEntries.set(input.payoutId, entry);

    return {
      ...entry,
      quarantined,
    };
  }

  release(payoutId: string, options: ReleasePayoutQuarantineOptions = {}): boolean {
    const existing = this.quarantineEntries.get(payoutId);
    if (!existing) {
      return false;
    }

    const now = new Date().toISOString();
    existing.status = "released";
    existing.releasedAt = now;
    existing.releaseReason = options.reason;
    existing.releasedBy = options.releasedBy;
    this.quarantineEntries.set(payoutId, existing);
    this.failureCounts.delete(payoutId);
    return true;
  }

  isQuarantined(payoutId: string): boolean {
    return this.quarantineEntries.get(payoutId)?.status === "quarantined";
  }

  get(payoutId: string): PayoutQuarantineEntry | undefined {
    const entry = this.quarantineEntries.get(payoutId);
    return entry ? { ...entry } : undefined;
  }

  list(): PayoutQuarantineEntry[] {
    return Array.from(this.quarantineEntries.values()).map((entry) => ({ ...entry }));
  }

  reset(): void {
    this.failureCounts.clear();
    this.quarantineEntries.clear();
  }
}

let defaultPayoutQuarantineService: PayoutQuarantineService | null = null;

export function getPayoutQuarantineService(): PayoutQuarantineService {
  if (!defaultPayoutQuarantineService) {
    defaultPayoutQuarantineService = new PayoutQuarantineService();
  }
  return defaultPayoutQuarantineService;
}

export function resetPayoutQuarantineState(): void {
  defaultPayoutQuarantineService = null;
}
