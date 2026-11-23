export interface BootstrapPolicy {
  requiredKycStatus: "verified";
  startingScore: number;
  bootstrapWindowDays: number;
  minGenuineTransactions: number;
  maxBootstrapPerIdentity: number;
  enabledRegions: string[] | null;
  scoreDecayStartDay: number;
}

export const DEFAULT_BOOTSTRAP_POLICY: BootstrapPolicy = {
  requiredKycStatus: "verified",
  startingScore: 75.0,
  bootstrapWindowDays: 30,
  minGenuineTransactions: 1,
  maxBootstrapPerIdentity: 1,
  enabledRegions: null,
  scoreDecayStartDay: 15,
};

export interface BootstrapRecord {
  supplierId: string;
  identityKey: string;
  grantedAt: Date;
  expiresAt: Date;
  consumed: boolean;
  consumedAt: Date | null;
  startingScore: number;
  kycRefAtGrant: string | null;
  region: string | null;
}

export interface BootstrapEvaluation {
  active: boolean;
  scoreContribution: number;
  expiresAt: Date | null;
  consumed: boolean;
  decayProgress: number;
  reasonInactive?: string;
}

interface TransactionRecord {
  id: string;
  supplierId: string;
  status: "pending" | "completed" | "expired" | "cancelled";
  createdAt: Date;
}

export class ReputationBootstrapService {
  private policy: BootstrapPolicy;
  private bootstraps: Map<string, BootstrapRecord> = new Map();
  private identityCounts: Map<string, number> = new Map();
  private transactions: TransactionRecord[] = [];
  private now: () => Date;

  constructor(policy: Partial<BootstrapPolicy> = {}, nowFn?: () => Date) {
    this.policy = { ...DEFAULT_BOOTSTRAP_POLICY, ...policy };
    this.now = nowFn ?? (() => new Date());
  }

  public getPolicy(): BootstrapPolicy {
    return { ...this.policy };
  }

  public identityKeyFor(email: string, kycRef: string | null): string {
    const emailNorm = email.trim().toLowerCase();
    const refPart = kycRef ? `:${kycRef}` : "";
    return `${emailNorm}${refPart}`;
  }

  public canGrant(
    supplierId: string,
    identityKey: string,
    kycStatus: string,
    region?: string | null
  ): { ok: boolean; reason?: string } {
    if (this.bootstraps.has(supplierId)) {
      return { ok: false, reason: "SUPPLIER_ALREADY_BOOTSTRAPPED" };
    }
    if (kycStatus !== this.policy.requiredKycStatus) {
      return { ok: false, reason: "KYC_NOT_VERIFIED" };
    }
    if ((this.identityCounts.get(identityKey) ?? 0) >= this.policy.maxBootstrapPerIdentity) {
      return { ok: false, reason: "IDENTITY_BOOTSTRAP_LIMIT_EXCEEDED" };
    }
    if (this.policy.enabledRegions && (!region || !this.policy.enabledRegions.includes(region))) {
      return { ok: false, reason: "REGION_POLICY_DISABLED" };
    }
    return { ok: true };
  }

  public grant(params: {
    supplierId: string;
    email: string;
    kycStatus: string;
    kycRef: string | null;
    region?: string | null;
  }): BootstrapRecord | null {
    const identityKey = this.identityKeyFor(params.email, params.kycRef);
    const check = this.canGrant(params.supplierId, identityKey, params.kycStatus, params.region);
    if (!check.ok) return null;

    const grantedAt = this.now();
    const expiresAt = new Date(grantedAt.getTime() + this.policy.bootstrapWindowDays * 24 * 60 * 60 * 1000);

    const record: BootstrapRecord = {
      supplierId: params.supplierId,
      identityKey,
      grantedAt,
      expiresAt,
      consumed: false,
      consumedAt: null,
      startingScore: this.policy.startingScore,
      kycRefAtGrant: params.kycRef,
      region: params.region ?? null,
    };

    this.bootstraps.set(params.supplierId, record);
    this.identityCounts.set(identityKey, (this.identityCounts.get(identityKey) ?? 0) + 1);
    return record;
  }

  public revoke(supplierId: string, _reason?: string): boolean {
    void _reason;
    const record = this.bootstraps.get(supplierId);
    if (!record) return false;
    this.bootstraps.delete(supplierId);
    const count = this.identityCounts.get(record.identityKey);
    if (typeof count === "number" && count > 0) {
      this.identityCounts.set(record.identityKey, count - 1);
    }
    return true;
  }

  public recordTransaction(tx: TransactionRecord): void {
    this.transactions.push(tx);
    if (tx.status === "completed") {
      const record = this.bootstraps.get(tx.supplierId);
      if (record && !record.consumed) {
        const genuineCount = this.countGenuineTransactions(tx.supplierId, tx.createdAt);
        if (genuineCount >= this.policy.minGenuineTransactions) {
          record.consumed = true;
          record.consumedAt = this.now();
        }
      }
    }
  }

  private countGenuineTransactions(supplierId: string, before?: Date): number {
    return this.transactions.filter((t) => {
      if (t.supplierId !== supplierId) return false;
      if (t.status !== "completed") return false;
      if (before && t.createdAt > before) return false;
      return true;
    }).length;
  }

  public evaluate(supplierId: string): BootstrapEvaluation {
    const record = this.bootstraps.get(supplierId);
    if (!record) {
      return {
        active: false,
        scoreContribution: 0,
        expiresAt: null,
        consumed: false,
        decayProgress: 0,
        reasonInactive: "NO_BOOTSTRAP",
      };
    }

    const currentTime = this.now();

    if (currentTime > record.expiresAt && !record.consumed) {
      return {
        active: false,
        scoreContribution: 0,
        expiresAt: record.expiresAt,
        consumed: false,
        decayProgress: 1.0,
        reasonInactive: "EXPIRED_UNUSED",
      };
    }

    if (record.consumed) {
      return {
        active: true,
        scoreContribution: record.startingScore,
        expiresAt: record.expiresAt,
        consumed: true,
        decayProgress: 0,
      };
    }

    const totalWindowMs = record.expiresAt.getTime() - record.grantedAt.getTime();
    const decayStartMs = this.policy.scoreDecayStartDay * 24 * 60 * 60 * 1000;
    const elapsedMs = currentTime.getTime() - record.grantedAt.getTime();

    let score = record.startingScore;
    let decayProgress = 0;

    if (elapsedMs > decayStartMs) {
      const decayWindowMs = totalWindowMs - decayStartMs;
      const decayElapsedMs = elapsedMs - decayStartMs;
      decayProgress = Math.min(1.0, Math.max(0, decayElapsedMs / Math.max(1, decayWindowMs)));
      const decayFactor = 1.0 - decayProgress;
      score = record.startingScore * decayFactor;
    }

    return {
      active: true,
      scoreContribution: Math.round(score * 10) / 10,
      expiresAt: record.expiresAt,
      consumed: false,
      decayProgress: Math.round(decayProgress * 1000) / 1000,
    };
  }

  public getRecord(supplierId: string): BootstrapRecord | undefined {
    return this.bootstraps.get(supplierId);
  }

  public tickSweep(): number {
    let removed = 0;
    const currentTime = this.now();
    for (const [supplierId, record] of this.bootstraps.entries()) {
      if (!record.consumed && currentTime > record.expiresAt) {
        this.bootstraps.delete(supplierId);
        const count = this.identityCounts.get(record.identityKey);
        if (typeof count === "number" && count > 0) {
          this.identityCounts.set(record.identityKey, count - 1);
        }
        removed++;
      }
    }
    return removed;
  }
}

export const reputationBootstrapService = new ReputationBootstrapService();
