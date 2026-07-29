import {
  TimezoneOverride,
  SupplierTimezoneContext,
  TenantTimezoneContext,
  TimezoneResolutionResult,
  TimezoneResolutionAuditEvent,
} from "../modules/slots/slot-repository.js";
import { AuditLogger, defaultAuditLogger } from "./auditLogger.js";

const VALID_TZ_REGEX = /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/;

export class InvalidTimezoneError extends Error {
  constructor(timezone: string) {
    super(`Invalid IANA timezone identifier: "${timezone}"`);
    this.name = "InvalidTimezoneError";
  }
}

export class TimezoneResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimezoneResolverError";
  }
}

export function isValidIanaTimezone(timezone: string): boolean {
  if (typeof timezone !== "string") return false;
  if (!VALID_TZ_REGEX.test(timezone)) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export interface TimezoneResolverDeps {
  getSupplierContext: (supplierId: string) => Promise<SupplierTimezoneContext | undefined>;
  getTenantContext: (tenantId: string) => Promise<TenantTimezoneContext | undefined>;
  auditLogger?: AuditLogger;
  now?: () => string;
}

export class TimezoneResolverService {
  private readonly getSupplierContext: (supplierId: string) => Promise<SupplierTimezoneContext | undefined>;
  private readonly getTenantContext: (tenantId: string) => Promise<TenantTimezoneContext | undefined>;
  private readonly auditLogger: AuditLogger;
  private readonly now: () => string;

  constructor(deps: TimezoneResolverDeps) {
    this.getSupplierContext = deps.getSupplierContext;
    this.getTenantContext = deps.getTenantContext;
    this.auditLogger = deps.auditLogger ?? defaultAuditLogger;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  validateTimezoneOverride(override: TimezoneOverride): void {
    if (!isValidIanaTimezone(override.timezone)) {
      throw new InvalidTimezoneError(override.timezone);
    }
    if (typeof override.setAt !== "string" || override.setAt.length === 0) {
      throw new TimezoneResolverError("TimezoneOverride.setAt is required");
    }
    if (typeof override.setBy !== "string" || override.setBy.length === 0) {
      throw new TimezoneResolverError("TimezoneOverride.setBy is required");
    }
  }

  async resolveTimezone(params: {
    supplierId: string;
    tenantId: string;
    storeId?: string;
    actorId?: string;
  }): Promise<TimezoneResolutionResult> {
    const { supplierId, tenantId, storeId, actorId } = params;

    if (typeof supplierId !== "string" || supplierId.length === 0) {
      throw new TimezoneResolverError("supplierId is required");
    }
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new TimezoneResolverError("tenantId is required");
    }

    const [supplierCtx, tenantCtx] = await Promise.all([
      this.getSupplierContext(supplierId),
      this.getTenantContext(tenantId),
    ]);

    if (!tenantCtx) {
      throw new TimezoneResolverError(`Tenant context not found for tenantId="${tenantId}"`);
    }
    if (!isValidIanaTimezone(tenantCtx.tenantDefaultTimezone)) {
      throw new InvalidTimezoneError(tenantCtx.tenantDefaultTimezone);
    }

    const candidates: TimezoneResolutionAuditEvent["candidates"] = {
      tenantTimezone: tenantCtx.tenantDefaultTimezone,
    };

    let result: TimezoneResolutionResult = {
      timezone: tenantCtx.tenantDefaultTimezone,
      source: "tenant",
    };

    if (supplierCtx?.supplierDefaultTimezone) {
      const supplierTz = supplierCtx.supplierDefaultTimezone;
      this.validateTimezoneOverride(supplierTz);
      candidates.supplierTimezone = supplierTz.timezone;
      result = {
        timezone: supplierTz.timezone,
        source: "supplier",
        setAt: supplierTz.setAt,
        setBy: supplierTz.setBy,
        reason: supplierTz.reason,
      };
    }

    if (storeId && supplierCtx?.stores?.[storeId]?.timezoneOverride) {
      const storeTz = supplierCtx.stores[storeId].timezoneOverride;
      this.validateTimezoneOverride(storeTz);
      candidates.storeTimezone = storeTz.timezone;
      result = {
        timezone: storeTz.timezone,
        source: "store",
        storeId,
        setAt: storeTz.setAt,
        setBy: storeTz.setBy,
        reason: storeTz.reason,
      };
    }

    const auditEvent: TimezoneResolutionAuditEvent = {
      supplierId,
      tenantId,
      storeId,
      resolvedTimezone: result.timezone,
      source: result.source,
      candidates,
      resolvedAt: this.now(),
      actorId,
    };

    await this.auditLogger.log("timezone.resolved", {
      context: auditEvent,
      userId: actorId,
    }, {
      resource: `supplier:${supplierId}${storeId ? `:store:${storeId}` : ""}`,
      status: 200,
    });

    return result;
  }

  resolveTimezoneSync(params: {
    supplierContext?: SupplierTimezoneContext;
    tenantContext: TenantTimezoneContext;
    storeId?: string;
  }): TimezoneResolutionResult {
    const { supplierContext, tenantContext, storeId } = params;

    if (!isValidIanaTimezone(tenantContext.tenantDefaultTimezone)) {
      throw new InvalidTimezoneError(tenantContext.tenantDefaultTimezone);
    }

    let result: TimezoneResolutionResult = {
      timezone: tenantContext.tenantDefaultTimezone,
      source: "tenant",
    };

    if (supplierContext?.supplierDefaultTimezone) {
      const supplierTz = supplierContext.supplierDefaultTimezone;
      this.validateTimezoneOverride(supplierTz);
      result = {
        timezone: supplierTz.timezone,
        source: "supplier",
        setAt: supplierTz.setAt,
        setBy: supplierTz.setBy,
        reason: supplierTz.reason,
      };
    }

    if (storeId && supplierContext?.stores?.[storeId]?.timezoneOverride) {
      const storeTz = supplierContext.stores[storeId].timezoneOverride;
      this.validateTimezoneOverride(storeTz);
      result = {
        timezone: storeTz.timezone,
        source: "store",
        storeId,
        setAt: storeTz.setAt,
        setBy: storeTz.setBy,
        reason: storeTz.reason,
      };
    }

    return result;
  }

  async setStoreTimezoneOverride(params: {
    supplierId: string;
    storeId: string;
    timezone: string;
    actorId: string;
    reason?: string;
    currentContext: SupplierTimezoneContext;
  }): Promise<{ context: SupplierTimezoneContext; audit: TimezoneResolutionAuditEvent; tenantId: string }> {
    const { supplierId, storeId, timezone, actorId, reason, currentContext } = params;

    if (!isValidIanaTimezone(timezone)) {
      throw new InvalidTimezoneError(timezone);
    }
    if (typeof storeId !== "string" || storeId.length === 0) {
      throw new TimezoneResolverError("storeId is required");
    }

    const override: TimezoneOverride = {
      timezone,
      setAt: this.now(),
      setBy: actorId,
      reason,
    };

    const updatedStores = { ...currentContext.stores };
    const existingStore = updatedStores[storeId] ?? { storeId };
    updatedStores[storeId] = {
      ...existingStore,
      storeId,
      timezoneOverride: override,
    };

    const updatedContext: SupplierTimezoneContext = {
      ...currentContext,
      supplierId,
      stores: updatedStores,
    };

    await this.auditLogger.log("timezone.store_override_set", {
      context: {
        supplierId,
        storeId,
        oldTimezone: existingStore.timezoneOverride?.timezone,
        newTimezone: timezone,
        reason,
      },
      userId: actorId,
    }, {
      resource: `supplier:${supplierId}:store:${storeId}`,
      status: 200,
    });

    return {
      context: updatedContext,
      tenantId: "",
      audit: {
        supplierId,
        tenantId: "",
        storeId,
        resolvedTimezone: timezone,
        source: "store",
        candidates: {
          storeTimezone: timezone,
          supplierTimezone: currentContext.supplierDefaultTimezone?.timezone,
          tenantTimezone: "",
        },
        resolvedAt: this.now(),
        actorId,
      },
    };
  }

  async setSupplierDefaultTimezone(params: {
    supplierId: string;
    timezone: string;
    actorId: string;
    reason?: string;
    currentContext: SupplierTimezoneContext;
  }): Promise<SupplierTimezoneContext> {
    const { supplierId, timezone, actorId, reason, currentContext } = params;

    if (!isValidIanaTimezone(timezone)) {
      throw new InvalidTimezoneError(timezone);
    }

    const override: TimezoneOverride = {
      timezone,
      setAt: this.now(),
      setBy: actorId,
      reason,
    };

    const updatedContext: SupplierTimezoneContext = {
      ...currentContext,
      supplierId,
      supplierDefaultTimezone: override,
    };

    await this.auditLogger.log("timezone.supplier_default_set", {
      context: {
        supplierId,
        oldTimezone: currentContext.supplierDefaultTimezone?.timezone,
        newTimezone: timezone,
        reason,
      },
      userId: actorId,
    }, {
      resource: `supplier:${supplierId}`,
      status: 200,
    });

    return updatedContext;
  }

  async clearStoreTimezoneOverride(params: {
    supplierId: string;
    storeId: string;
    actorId: string;
    currentContext: SupplierTimezoneContext;
  }): Promise<SupplierTimezoneContext> {
    const { supplierId, storeId, actorId, currentContext } = params;

    const existingStore = currentContext.stores[storeId];
    if (!existingStore?.timezoneOverride) {
      return currentContext;
    }

    const oldTimezone = existingStore.timezoneOverride.timezone;
    const updatedStores = { ...currentContext.stores };
    updatedStores[storeId] = {
      ...existingStore,
      timezoneOverride: undefined,
    };

    const updatedContext: SupplierTimezoneContext = {
      ...currentContext,
      stores: updatedStores,
    };

    await this.auditLogger.log("timezone.store_override_cleared", {
      context: {
        supplierId,
        storeId,
        clearedTimezone: oldTimezone,
      },
      userId: actorId,
    }, {
      resource: `supplier:${supplierId}:store:${storeId}`,
      status: 200,
    });

    return updatedContext;
  }

  getRegionsForStore(params: {
    supplierContext?: SupplierTimezoneContext;
    storeId?: string;
  }): string[] {
    const { supplierContext, storeId } = params;
    if (!storeId || !supplierContext?.stores?.[storeId]) {
      return [];
    }
    return supplierContext.stores[storeId].regionCodes ?? [];
  }

  getAllRegionsForSupplier(supplierContext?: SupplierTimezoneContext): string[] {
    if (!supplierContext?.stores) return [];
    const regionSet = new Set<string>();
    for (const store of Object.values(supplierContext.stores)) {
      for (const region of store.regionCodes ?? []) {
        regionSet.add(region);
      }
    }
    return Array.from(regionSet);
  }
}

export function createInMemoryTimezoneResolverDeps(initial?: {
  suppliers?: Record<string, SupplierTimezoneContext>;
  tenants?: Record<string, TenantTimezoneContext>;
  auditLogger?: AuditLogger;
}): TimezoneResolverDeps & {
  suppliers: Record<string, SupplierTimezoneContext>;
  tenants: Record<string, TenantTimezoneContext>;
} {
  const suppliers = initial?.suppliers ?? {};
  const tenants = initial?.tenants ?? {};
  return {
    suppliers,
    tenants,
    getSupplierContext: async (id) => suppliers[id],
    getTenantContext: async (id) => tenants[id],
    auditLogger: initial?.auditLogger,
  };
}
