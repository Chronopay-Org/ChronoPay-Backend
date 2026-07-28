/**
 * Hold Fee Retention Policy
 *
 * Some suppliers charge a small non-refundable hold fee for refundable holds.
 * This module provides a per-supplier policy model that defaults to zero
 * retention (no hold fee).
 *
 * The hold fee is captured as a snapshot at booking creation time and deducted
 * from any refund that is subsequently issued. The disclosed retention amount
 * is visible in the refund breakdown (see RefundBreakdown.holdFee).
 */

import type { AuditLogger } from "./auditLogger.js";
import { defaultAuditLogger } from "./auditLogger.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Per-supplier hold fee configuration.
 * The `holdFeeCents` is the non-refundable amount in the smallest currency unit
 * (e.g. cents for fiat, stroops for XLM). Defaults to 0 when not configured.
 */
export interface HoldFeePolicy {
  /** Supplier this policy applies to. */
  supplierId: string;
  /**
   * Non-refundable hold fee in smallest currency unit.
   * Must be >= 0 (0 means no hold fee / fully refundable hold).
   */
  holdFeeCents: number;
  /** ISO 8601 timestamp when this policy was created/updated. */
  updatedAt: string;
}

/**
 * Immutable snapshot of the hold fee policy captured at booking creation time.
 * Stored on the BookingIntentRecord for auditability — the hold fee that
 * applies to a booking never changes after creation, even if the supplier
 * later updates their policy.
 */
export interface HoldFeePolicySnapshot {
  /** Supplier who owns the policy. */
  supplierId: string;
  /** Non-refundable hold fee in cents, captured at booking time. */
  holdFeeCents: number;
  /** Timestamp (ms) when the snapshot was captured. */
  capturedAtMs: number;
}

// ─── Registry ──────────────────────────────────────────────────────────────────

export interface HoldFeePolicyRegistry {
  entries: Record<string, HoldFeePolicy>;
}

/**
 * Create an empty registry with no suppliers configured.
 * All suppliers default to 0 hold fee.
 */
export function createEmptyHoldFeeRegistry(): HoldFeePolicyRegistry {
  return { entries: {} };
}

/**
 * Resolve the effective hold fee for a supplier.
 * If the supplier has configured a policy, uses that; otherwise defaults to 0.
 */
export function resolveHoldFeeCents(
  registry: HoldFeePolicyRegistry,
  supplierId: string,
): number {
  const policy = registry.entries[supplierId];
  if (!policy) return 0;
  return Math.max(0, policy.holdFeeCents);
}

// ─── Validation ────────────────────────────────────────────────────────────────

export function validateHoldFeePolicy(policy: HoldFeePolicy): void {
  if (!policy.supplierId || typeof policy.supplierId !== "string") {
    throw new Error("HoldFeePolicy: supplierId must be a non-empty string");
  }
  if (!Number.isFinite(policy.holdFeeCents) || policy.holdFeeCents < 0) {
    throw new Error(
      `HoldFeePolicy: holdFeeCents must be a finite non-negative number, got ${policy.holdFeeCents}`,
    );
  }
  if (policy.holdFeeCents > 1_000_000_000) {
    throw new Error("HoldFeePolicy: holdFeeCents exceeds maximum allowed (1_000_000_000)");
  }
}

// ─── Service ───────────────────────────────────────────────────────────────────

export interface HoldFeePolicyServiceDeps {
  getRegistry?: () => HoldFeePolicyRegistry;
  auditLogger?: AuditLogger;
  nowMs?: () => number;
}

export class HoldFeePolicyService {
  private readonly getRegistry: () => HoldFeePolicyRegistry;
  private readonly auditLogger: AuditLogger;
  private readonly nowMs: () => number;

  constructor(deps: HoldFeePolicyServiceDeps = {}) {
    const defaultRegistry = createEmptyHoldFeeRegistry();
    this.getRegistry = deps.getRegistry ?? (() => defaultRegistry);
    this.auditLogger = deps.auditLogger ?? defaultAuditLogger;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  /**
   * Capture a snapshot of the hold fee policy for a supplier at the current
   * moment. This snapshot is intended to be stored on a BookingIntentRecord
   * so that the hold fee applicable at booking creation time is grandfathered.
   */
  snapshotForSupplier(supplierId: string): HoldFeePolicySnapshot {
    const registry = this.getRegistry();
    const holdFeeCents = resolveHoldFeeCents(registry, supplierId);
    return {
      supplierId,
      holdFeeCents,
      capturedAtMs: this.nowMs(),
    };
  }

  /**
   * Compute the retention (non-refundable hold fee) given a snapshot.
   * Returns 0 for empty/missing snapshots.
   */
  computeRetention(snapshot?: HoldFeePolicySnapshot): number {
    if (!snapshot) return 0;
    return Math.max(0, snapshot.holdFeeCents);
  }

  /**
   * Deduct the hold fee retention from a refund amount.
   * Returns the net refund after retention (clamped to 0).
   */
  deductRetention(refundAmount: number, snapshot?: HoldFeePolicySnapshot): number {
    const retention = this.computeRetention(snapshot);
    return Math.max(0, refundAmount - retention);
  }

  /**
   * Register or update a hold fee policy for a supplier.
   * If the supplier already has a policy, it is overwritten.
   */
  upsertPolicy(
    registry: HoldFeePolicyRegistry,
    params: {
      supplierId: string;
      holdFeeCents: number;
    },
  ): HoldFeePolicyRegistry {
    const { supplierId, holdFeeCents } = params;
    const nowIso = new Date(this.nowMs()).toISOString();

    const policy: HoldFeePolicy = {
      supplierId,
      holdFeeCents: Math.max(0, holdFeeCents),
      updatedAt: nowIso,
    };

    validateHoldFeePolicy(policy);

    const newEntries = { ...registry.entries, [supplierId]: policy };

    this.auditLogger
      .log("hold_fee_policy.upserted", {
        context: { supplierId, holdFeeCents, updatedAt: nowIso },
      }, { status: 200, resource: `hold-fee-policy:${supplierId}` })
      .catch(() => {});

    return { entries: newEntries };
  }

  /**
   * Get the policy for a supplier, or undefined if none configured.
   */
  getPolicy(registry: HoldFeePolicyRegistry, supplierId: string): HoldFeePolicy | undefined {
    return registry.entries[supplierId];
  }

  /**
   * List all configured policies.
   */
  listPolicies(registry: HoldFeePolicyRegistry): HoldFeePolicy[] {
    return Object.values(registry.entries).sort((a, b) =>
      a.supplierId.localeCompare(b.supplierId),
    );
  }
}