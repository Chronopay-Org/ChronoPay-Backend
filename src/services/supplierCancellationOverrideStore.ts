import { ProratedCancellationTerms } from "../modules/booking-intents/booking-intent-repository.js";
import { validateProratedCancellationTerms } from "./cancellationPolicy.js";
import { AuditLogger, defaultAuditLogger } from "./auditLogger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SupplierCancellationOverride {
  /** Supplier (professional) ID this override applies to */
  supplierId: string;
  /** Custom cancellation terms for this supplier */
  terms: ProratedCancellationTerms;
  /** ISO 8601 timestamp when this override was created */
  createdAt: string;
  /** ISO 8601 timestamp when this override was last modified */
  updatedAt: string;
  /** Who created this override */
  createdBy: string;
  /** Who last modified this override */
  updatedBy: string;
  /** Optional description / reason for the override */
  description?: string;
}

export interface SupplierOverrideChangeAudit {
  supplierId: string;
  action: "created" | "updated" | "deleted";
  changedBy: string;
  at: string;
  previousTerms?: ProratedCancellationTerms;
  newTerms?: ProratedCancellationTerms;
  description?: string;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export interface SupplierCancellationOverrideStore {
  getOverride(supplierId: string): SupplierCancellationOverride | undefined;
  listOverrides(): SupplierCancellationOverride[];
  setOverride(
    supplierId: string,
    terms: ProratedCancellationTerms,
    changedBy: string,
    description?: string,
  ): Promise<SupplierCancellationOverride>;
  deleteOverride(supplierId: string, changedBy: string): Promise<boolean>;
}

export class InMemorySupplierCancellationOverrideStore
  implements SupplierCancellationOverrideStore
{
  private readonly overrides: Map<string, SupplierCancellationOverride> = new Map();
  private readonly auditLogger: AuditLogger;
  private readonly nowIso: () => string;

  constructor(deps?: {
    auditLogger?: AuditLogger;
    nowIso?: () => string;
    /** Seed with initial overrides (for testing) */
    seed?: SupplierCancellationOverride[];
  }) {
    this.auditLogger = deps?.auditLogger ?? defaultAuditLogger;
    this.nowIso = deps?.nowIso ?? (() => new Date().toISOString());
    if (deps?.seed) {
      for (const override of deps.seed) {
        this.overrides.set(override.supplierId, { ...override });
      }
    }
  }

  getOverride(supplierId: string): SupplierCancellationOverride | undefined {
    return this.overrides.get(supplierId);
  }

  listOverrides(): SupplierCancellationOverride[] {
    return Array.from(this.overrides.values()).sort((a, b) =>
      a.supplierId.localeCompare(b.supplierId),
    );
  }

  async setOverride(
    supplierId: string,
    terms: ProratedCancellationTerms,
    changedBy: string,
    description?: string,
  ): Promise<SupplierCancellationOverride> {
    if (typeof supplierId !== "string" || supplierId.trim().length === 0) {
      throw new Error("supplierId must be a non-empty string");
    }
    validateProratedCancellationTerms(terms);

    const now = this.nowIso();
    const existing = this.overrides.get(supplierId);
    const audit: SupplierOverrideChangeAudit = {
      supplierId,
      action: existing ? "updated" : "created",
      changedBy,
      at: now,
      previousTerms: existing ? { ...existing.terms } : undefined,
      newTerms: { ...terms },
      description,
    };

    const override: SupplierCancellationOverride = {
      supplierId,
      terms,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      createdBy: existing?.createdBy ?? changedBy,
      updatedBy: changedBy,
      description: description ?? existing?.description,
    };

    this.overrides.set(supplierId, override);

    await this.auditLogger.log(
      "cancellation_policy.supplier_override",
      {
        context: audit,
        userId: changedBy,
      },
      {
        resource: `supplier-cancellation-override:${supplierId}`,
        status: 200,
      },
    );

    return { ...override };
  }

  async deleteOverride(supplierId: string, changedBy: string): Promise<boolean> {
    const existing = this.overrides.get(supplierId);
    if (!existing) {
      return false;
    }

    const now = this.nowIso();
    const audit: SupplierOverrideChangeAudit = {
      supplierId,
      action: "deleted",
      changedBy,
      at: now,
      previousTerms: { ...existing.terms },
      description: existing.description,
    };

    this.overrides.delete(supplierId);

    await this.auditLogger.log(
      "cancellation_policy.supplier_override_deleted",
      {
        context: audit,
        userId: changedBy,
      },
      {
        resource: `supplier-cancellation-override:${supplierId}`,
        status: 200,
      },
    );

    return true;
  }

  /** Reset all overrides — useful in tests */
  reset(): void {
    this.overrides.clear();
  }
}

// ─── Default singleton ───────────────────────────────────────────────────────

export const defaultSupplierCancellationOverrideStore =
  new InMemorySupplierCancellationOverrideStore();
