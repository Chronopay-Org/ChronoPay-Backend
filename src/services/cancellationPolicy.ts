import {
  BookingIntentRecord,
  ProratedCancellationTerms,
  CancellationPolicyVersion,
  CancellationPolicySnapshot,
} from "../modules/booking-intents/booking-intent-repository.js";
import { BookingIntentError } from "../modules/booking-intents/booking-intent-service.js";
import { AuditLogger, defaultAuditLogger } from "./auditLogger.js";
import { HoldFeePolicyService } from "./holdFeePolicy.js";

export interface RefundBreakdown {
  fee: number;
  taxReversal: number;
  netRefund: number;
  /** Policy version used for the calculation (grandfathered from booking) */
  policyVersion: string;
  /** Tier that was selected, for audit/debugging */
  tierApplied: {
    minHoursUntilStart: number;
    maxHoursUntilStart?: number;
    refundRatio: number;
  } | null;
  /** Hours until slot start when the cancellation was requested */
  hoursUntilStart: number;
  /** Base price before any adjustments */
  basePrice: number;
  /**
   * Non-refundable hold fee retention in smallest currency unit.
   * Deducted from the cancellation refund. Disclosed separately
   * so it is visible in the booking receipt.
   * Defaults to 0 when no hold fee policy applies.
   */
  holdFee: number;
}

export interface CancellationPolicyChangeAudit {
  oldVersionId?: string;
  newVersionId: string;
  effectiveFrom: string;
  changedBy: string;
  description: string;
  changeType: "created" | "superseded" | "reactivated";
  at: string;
}

const LEGACY_V1_TERMS: ProratedCancellationTerms = {
  tiers: [
    {
      minHoursUntilStart: 24,
      refundRatio: 1.0,
      percentageFee: 0.05,
      taxReversalRatio: 0.1,
    },
    {
      minHoursUntilStart: 12,
      maxHoursUntilStart: 24,
      refundRatio: 0.5,
      percentageFee: 0.05,
      taxReversalRatio: 0.1,
    },
    {
      minHoursUntilStart: 0,
      maxHoursUntilStart: 12,
      refundRatio: 0.0,
      percentageFee: 0.05,
      taxReversalRatio: 0.1,
    },
  ],
  minRefundAmount: 0,
};

export const LEGACY_V1_VERSION: CancellationPolicyVersion = {
  versionId: "v1-timezone-tier",
  effectiveFrom: "1970-01-01T00:00:00.000Z",
  description:
    "Original tiered policy: 100% refund ≥24h, 50% 12–24h, 0% <12h. 5% fee, 10% tax reversal.",
};

export const PRORATED_V2_TERMS: ProratedCancellationTerms = {
  tiers: [
    {
      minHoursUntilStart: 168,
      refundRatio: 1.0,
      flatFee: 0,
      taxReversalRatio: 0.1,
    },
    {
      minHoursUntilStart: 72,
      maxHoursUntilStart: 168,
      refundRatio: 0.85,
      flatFee: 0,
      taxReversalRatio: 0.1,
    },
    {
      minHoursUntilStart: 24,
      maxHoursUntilStart: 72,
      refundRatio: 0.6,
      flatFee: 50,
      taxReversalRatio: 0.1,
    },
    {
      minHoursUntilStart: 12,
      maxHoursUntilStart: 24,
      refundRatio: 0.3,
      flatFee: 100,
      taxReversalRatio: 0.1,
    },
    {
      minHoursUntilStart: 0,
      maxHoursUntilStart: 12,
      refundRatio: 0.0,
      flatFee: 0,
      taxReversalRatio: 0.1,
    },
  ],
  minRefundAmount: 0,
};

export const PRORATED_V2_VERSION: CancellationPolicyVersion = {
  versionId: "v2-prorated",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  description:
    "Prorated tiered policy: 100% ≥7d, 85% 3–7d, 60% 1–3d (+50 flat), 30% 12h–1d (+100 flat), 0% <12h.",
};

export function validateProratedCancellationTerms(terms: ProratedCancellationTerms): void {
  if (!terms || !Array.isArray(terms.tiers) || terms.tiers.length === 0) {
    throw new Error("ProratedCancellationTerms must have at least one tier");
  }

  const sorted = [...terms.tiers].sort((a, b) => a.minHoursUntilStart - b.minHoursUntilStart);
  let prevMax: number | undefined;

  for (let i = 0; i < sorted.length; i++) {
    const tier = sorted[i];
    if (tier.minHoursUntilStart < 0 || !Number.isFinite(tier.minHoursUntilStart)) {
      throw new Error(`Tier ${i}: minHoursUntilStart must be a finite non-negative number`);
    }
    if (tier.maxHoursUntilStart !== undefined && (!Number.isFinite(tier.maxHoursUntilStart) || tier.maxHoursUntilStart <= tier.minHoursUntilStart)) {
      throw new Error(`Tier ${i}: maxHoursUntilStart must be > minHoursUntilStart`);
    }
    if (tier.refundRatio < 0 || tier.refundRatio > 1 || !Number.isFinite(tier.refundRatio)) {
      throw new Error(`Tier ${i}: refundRatio must be in [0, 1]`);
    }
    if (tier.flatFee !== undefined && (!Number.isFinite(tier.flatFee) || tier.flatFee < 0)) {
      throw new Error(`Tier ${i}: flatFee must be a finite non-negative number`);
    }
    if (tier.percentageFee !== undefined && (tier.percentageFee < 0 || tier.percentageFee > 1 || !Number.isFinite(tier.percentageFee))) {
      throw new Error(`Tier ${i}: percentageFee must be in [0, 1]`);
    }
    if (prevMax !== undefined && tier.minHoursUntilStart < prevMax) {
      throw new Error(`Tier ${i}: overlaps with previous tier (gap or overlap detected at ${tier.minHoursUntilStart}h)`);
    }
    prevMax = tier.maxHoursUntilStart;
  }

  if (terms.minRefundAmount !== undefined && (!Number.isFinite(terms.minRefundAmount) || terms.minRefundAmount < 0)) {
    throw new Error("minRefundAmount must be a finite non-negative number");
  }
  if (terms.maxRefundAmount !== undefined && (!Number.isFinite(terms.maxRefundAmount) || terms.maxRefundAmount < 0)) {
    throw new Error("maxRefundAmount must be a finite non-negative number");
  }
  if (
    terms.minRefundAmount !== undefined &&
    terms.maxRefundAmount !== undefined &&
    terms.maxRefundAmount < terms.minRefundAmount
  ) {
    throw new Error("maxRefundAmount must be >= minRefundAmount");
  }
}

export function selectTierForCancellation(
  terms: ProratedCancellationTerms,
  hoursUntilStart: number,
): ProratedCancellationTerms["tiers"][number] | null {
  const sorted = [...terms.tiers].sort((a, b) => b.minHoursUntilStart - a.minHoursUntilStart);
  for (const tier of sorted) {
    const aboveMin = hoursUntilStart >= tier.minHoursUntilStart;
    const belowMax = tier.maxHoursUntilStart === undefined || hoursUntilStart < tier.maxHoursUntilStart;
    if (aboveMin && belowMax) {
      return tier;
    }
  }
  return null;
}

export function computeRefundWithTerms(
  terms: ProratedCancellationTerms,
  price: number,
  hoursUntilStart: number,
  policyVersionId: string,
): RefundBreakdown {
  if (price < 0) {
    throw new Error("price must be non-negative");
  }

  const tier = selectTierForCancellation(terms, hoursUntilStart);

  if (!tier) {
    return {
      fee: 0,
      taxReversal: 0,
      netRefund: 0,
      policyVersion: policyVersionId,
      tierApplied: null,
      hoursUntilStart,
      basePrice: price,
      holdFee: 0,
    };
  }

  const baseRefund = Math.max(0, Math.round(price * tier.refundRatio));
  const percentageFee = tier.percentageFee ? Math.round(baseRefund * tier.percentageFee) : 0;
  const flatFee = tier.flatFee ?? 0;
  const fee = percentageFee + flatFee;
  const taxReversal = tier.taxReversalRatio ? Math.round(baseRefund * tier.taxReversalRatio) : 0;

  let netRefund = baseRefund + taxReversal - fee;

  if (terms.minRefundAmount !== undefined) {
    netRefund = Math.max(terms.minRefundAmount, netRefund);
  }
  if (terms.maxRefundAmount !== undefined) {
    netRefund = Math.min(terms.maxRefundAmount, netRefund);
  }

  netRefund = Math.max(0, netRefund);

  return {
    fee,
    taxReversal,
    netRefund,
    policyVersion: policyVersionId,
    tierApplied: {
      minHoursUntilStart: tier.minHoursUntilStart,
      maxHoursUntilStart: tier.maxHoursUntilStart,
      refundRatio: tier.refundRatio,
    },
    hoursUntilStart,
    basePrice: price,
    holdFee: 0,
  };
}

export function applyHoldFeeToRefund(
  breakdown: RefundBreakdown,
  holdFeeCents: number,
): RefundBreakdown {
  const validatedFee = Math.max(0, Math.round(holdFeeCents));
  const netRefund = Math.max(0, breakdown.netRefund - validatedFee);
  return {
    ...breakdown,
    holdFee: validatedFee,
    netRefund,
  };
}

export interface VersionedPolicyRegistryEntry {
  version: CancellationPolicyVersion;
  terms: ProratedCancellationTerms;
}

export interface VersionedPolicyRegistry {
  entries: Record<string, VersionedPolicyRegistryEntry>;
  currentVersionId: string;
}

export function createDefaultRegistry(): VersionedPolicyRegistry {
  return {
    currentVersionId: PRORATED_V2_VERSION.versionId,
    entries: {
      [LEGACY_V1_VERSION.versionId]: {
        version: LEGACY_V1_VERSION,
        terms: LEGACY_V1_TERMS,
      },
      [PRORATED_V2_VERSION.versionId]: {
        version: PRORATED_V2_VERSION,
        terms: PRORATED_V2_TERMS,
      },
    },
  };
}

export interface CancellationPolicyServiceDeps {
  getPolicyRegistry?: () => Promise<VersionedPolicyRegistry>;
  getPolicyRegistrySync?: () => VersionedPolicyRegistry;
  auditLogger?: AuditLogger;
  nowMs?: () => number;
  nowIso?: () => string;
}

export class CancellationPolicyService {
  private readonly getPolicyRegistry: () => Promise<VersionedPolicyRegistry>;
  private readonly getPolicyRegistrySync: () => VersionedPolicyRegistry;
  private readonly auditLogger: AuditLogger;
  private readonly nowMs: () => number;
  private readonly nowIso: () => string;

  constructor(deps: CancellationPolicyServiceDeps = {}) {
    const defaultRegistry = createDefaultRegistry();
    this.getPolicyRegistry = deps.getPolicyRegistry ?? (async () => defaultRegistry);
    this.getPolicyRegistrySync = deps.getPolicyRegistrySync ?? (() => defaultRegistry);
    this.auditLogger = deps.auditLogger ?? defaultAuditLogger;
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
  }

  snapshotCurrentPolicy(overrideTerms?: ProratedCancellationTerms): CancellationPolicySnapshot {
    const registry = this.getPolicyRegistrySync();
    const entry = registry.entries[registry.currentVersionId];
    if (!entry) {
      throw new Error(`Current policy version "${registry.currentVersionId}" is not in registry`);
    }
    const terms = overrideTerms ?? entry.terms;
    validateProratedCancellationTerms(terms);
    return {
      policyVersionId: entry.version.versionId,
      policyTerms: terms,
      capturedAtMs: this.nowMs(),
    };
  }

  snapshotPolicyAtTime(whenMs: number, overrideTerms?: ProratedCancellationTerms): CancellationPolicySnapshot {
    const registry = this.getPolicyRegistrySync();
    const whenIso = new Date(whenMs).toISOString();

    const activeVersions = Object.values(registry.entries).filter((e) => {
      const startOk = e.version.effectiveFrom <= whenIso;
      const endOk =
        e.version.effectiveUntil === undefined || whenIso < e.version.effectiveUntil;
      return startOk && endOk;
    });

    if (activeVersions.length === 0) {
      return this.snapshotCurrentPolicy(overrideTerms);
    }

    activeVersions.sort(
      (a, b) =>
        new Date(b.version.effectiveFrom).getTime() - new Date(a.version.effectiveFrom).getTime(),
    );
    const chosen = activeVersions[0];
    const terms = overrideTerms ?? chosen.terms;
    validateProratedCancellationTerms(terms);
    return {
      policyVersionId: chosen.version.versionId,
      policyTerms: terms,
      capturedAtMs: this.nowMs(),
    };
  }

  calculateRefund(
    intent: BookingIntentRecord,
    holdFeeService?: HoldFeePolicyService,
  ): RefundBreakdown {
    if (intent.status === "cancelled") {
      throw new BookingIntentError(409, "Already cancelled");
    }

    const price = intent.pricingSnapshot?.resolvedPrice ?? 0;
    const msUntilStart = intent.startTime - this.nowMs();
    const hoursUntilStart = msUntilStart / (1000 * 60 * 60);

    let policyVersionId: string;
    let terms: ProratedCancellationTerms;

    if (intent.cancellationPolicySnapshot) {
      policyVersionId = intent.cancellationPolicySnapshot.policyVersionId;
      terms = intent.cancellationPolicySnapshot.policyTerms;
    } else {
      const registry = this.getPolicyRegistrySync();
      const fallback = registry.entries[LEGACY_V1_VERSION.versionId];
      policyVersionId = LEGACY_V1_VERSION.versionId;
      terms = fallback ? fallback.terms : LEGACY_V1_TERMS;
    }

    validateProratedCancellationTerms(terms);
    const breakdown = computeRefundWithTerms(terms, price, hoursUntilStart, policyVersionId);

    // Apply hold fee retention if a snapshot exists on the intent
    if (intent.holdFeePolicySnapshot) {
      const svc = holdFeeService ?? new HoldFeePolicyService();
      const holdFeeCents = svc.computeRetention(intent.holdFeePolicySnapshot);
      return applyHoldFeeToRefund(breakdown, holdFeeCents);
    }

    return breakdown;
  }

  async previewRefundWithOverride(
    intent: BookingIntentRecord,
    overrideTerms: ProratedCancellationTerms,
    holdFeeService?: HoldFeePolicyService,
  ): Promise<RefundBreakdown> {
    if (intent.status === "cancelled") {
      throw new BookingIntentError(409, "Already cancelled");
    }
    validateProratedCancellationTerms(overrideTerms);
    const price = intent.pricingSnapshot?.resolvedPrice ?? 0;
    const msUntilStart = intent.startTime - this.nowMs();
    const hoursUntilStart = msUntilStart / (1000 * 60 * 60);

    const version = intent.cancellationPolicySnapshot?.policyVersionId ?? "override-preview";
    const breakdown = computeRefundWithTerms(overrideTerms, price, hoursUntilStart, version);

    if (intent.holdFeePolicySnapshot) {
      const svc = holdFeeService ?? new HoldFeePolicyService();
      const holdFeeCents = svc.computeRetention(intent.holdFeePolicySnapshot);
      return applyHoldFeeToRefund(breakdown, holdFeeCents);
    }

    return breakdown;
  }

  async registerNewPolicyVersion(params: {
    versionId: string;
    description: string;
    terms: ProratedCancellationTerms;
    effectiveFrom?: string;
    makeCurrent?: boolean;
    changedBy: string;
    existingRegistry: VersionedPolicyRegistry;
  }): Promise<{ registry: VersionedPolicyRegistry; audit: CancellationPolicyChangeAudit }> {
    const { versionId, description, terms, effectiveFrom, makeCurrent, changedBy, existingRegistry } = params;

    if (typeof versionId !== "string" || versionId.trim().length === 0) {
      throw new Error("versionId must be a non-empty string");
    }
    if (existingRegistry.entries[versionId]) {
      throw new Error(`Policy version "${versionId}" already exists`);
    }
    validateProratedCancellationTerms(terms);

    const nowIso = this.nowIso();
    const version: CancellationPolicyVersion = {
      versionId,
      effectiveFrom: effectiveFrom ?? nowIso,
      description,
    };

    const newEntries = { ...existingRegistry.entries, [versionId]: { version, terms } };
    let newCurrentVersionId = existingRegistry.currentVersionId;

    if (makeCurrent) {
      const previousCurrent = existingRegistry.entries[existingRegistry.currentVersionId];
      if (previousCurrent) {
        newEntries[existingRegistry.currentVersionId] = {
          ...previousCurrent,
          version: {
            ...previousCurrent.version,
            effectiveUntil: version.effectiveFrom,
          },
        };
      }
      newCurrentVersionId = versionId;
    }

    const registry: VersionedPolicyRegistry = {
      entries: newEntries,
      currentVersionId: newCurrentVersionId,
    };

    const audit: CancellationPolicyChangeAudit = {
      oldVersionId: makeCurrent ? existingRegistry.currentVersionId : undefined,
      newVersionId: versionId,
      effectiveFrom: version.effectiveFrom,
      changedBy,
      description,
      changeType: "created",
      at: nowIso,
    };

    await this.auditLogger.log("cancellation_policy.version_registered", {
      context: audit,
      userId: changedBy,
    }, {
      resource: `cancellation-policy:${versionId}`,
      status: 200,
    });

    return { registry, audit };
  }

  listPolicyVersions(): VersionedPolicyRegistryEntry[] {
    const registry = this.getPolicyRegistrySync();
    return Object.values(registry.entries).sort(
      (a, b) =>
        new Date(b.version.effectiveFrom).getTime() - new Date(a.version.effectiveFrom).getTime(),
    );
  }

  getCurrentVersion(): VersionedPolicyRegistryEntry {
    const registry = this.getPolicyRegistrySync();
    const entry = registry.entries[registry.currentVersionId];
    if (!entry) {
      throw new Error(`Current policy version "${registry.currentVersionId}" not found`);
    }
    return entry;
  }
}
