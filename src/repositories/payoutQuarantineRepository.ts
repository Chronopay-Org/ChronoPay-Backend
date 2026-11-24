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

export interface PayoutQuarantineFailure {
  payoutId: string;
  supplierId?: string;
  errorClass?: string;
  errorMessage?: string;
  threshold: number;
  operationId: string;
}

export interface PayoutQuarantineUpsertResult {
  entry: PayoutQuarantineEntry;
  newlyQuarantined: boolean;
}

export interface PayoutQuarantineRepository {
  get(payoutId: string): Promise<PayoutQuarantineEntry | undefined>;
  upsert(failure: PayoutQuarantineFailure): Promise<PayoutQuarantineUpsertResult>;
  list(): Promise<PayoutQuarantineEntry[]>;
  release(
    payoutId: string,
    options: ReleasePayoutQuarantineOptions,
  ): Promise<boolean>;
  reset?(): void;
}

function cloneEntry(entry: PayoutQuarantineEntry): PayoutQuarantineEntry {
  return { ...entry };
}

export class InMemoryPayoutQuarantineRepository
  implements PayoutQuarantineRepository
{
  private readonly entries = new Map<string, PayoutQuarantineEntry>();

  async get(payoutId: string): Promise<PayoutQuarantineEntry | undefined> {
    const entry = this.entries.get(payoutId);
    return entry ? cloneEntry(entry) : undefined;
  }

  async upsert(
    failure: PayoutQuarantineFailure,
  ): Promise<PayoutQuarantineUpsertResult> {
    const existing = this.entries.get(failure.payoutId);
    const totalFailures =
      existing?.status === "released" ? 1 : (existing?.totalFailures ?? 0) + 1;
    const reachedThreshold =
      failure.threshold <= 0 || totalFailures >= failure.threshold;
    const newlyQuarantined =
      reachedThreshold && existing?.status !== "quarantined";
    const entry: PayoutQuarantineEntry = {
      payoutId: failure.payoutId,
      supplierId: failure.supplierId ?? existing?.supplierId,
      totalFailures,
      threshold: failure.threshold,
      status: newlyQuarantined
        ? "quarantined"
        : existing?.status === "quarantined"
          ? "quarantined"
          : "active",
      lastErrorClass: failure.errorClass ?? existing?.lastErrorClass,
      lastErrorMessage: failure.errorMessage ?? existing?.lastErrorMessage,
      quarantinedAt: existing?.quarantinedAt,
      releasedAt: existing?.releasedAt,
      quarantineReason: existing?.quarantineReason,
      releaseReason: existing?.releaseReason,
      releasedBy: existing?.releasedBy,
    };

    if (newlyQuarantined) {
      entry.quarantinedAt = new Date().toISOString();
      entry.quarantineReason = "failure-threshold-reached";
      entry.releasedAt = undefined;
      entry.releaseReason = undefined;
      entry.releasedBy = undefined;
    }

    this.entries.set(failure.payoutId, entry);
    return { entry: cloneEntry(entry), newlyQuarantined };
  }

  async list(): Promise<PayoutQuarantineEntry[]> {
    return Array.from(this.entries.values(), cloneEntry);
  }

  async release(
    payoutId: string,
    options: ReleasePayoutQuarantineOptions,
  ): Promise<boolean> {
    const existing = this.entries.get(payoutId);
    if (!existing) return false;

    existing.status = "released";
    existing.releasedAt = new Date().toISOString();
    existing.releaseReason = options.reason;
    existing.releasedBy = options.releasedBy;
    this.entries.set(payoutId, existing);
    return true;
  }

  reset(): void {
    this.entries.clear();
  }
}
