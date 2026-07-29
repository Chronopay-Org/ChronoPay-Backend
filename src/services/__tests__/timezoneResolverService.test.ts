import {
  TimezoneResolverService,
  createInMemoryTimezoneResolverDeps,
  isValidIanaTimezone,
  InvalidTimezoneError,
  TimezoneResolverError,
} from "../timezoneResolverService.js";
import type {
  SupplierTimezoneContext,
  TenantTimezoneContext,
} from "../../modules/slots/slot-repository.js";
import { AuditLogger } from "../auditLogger.js";

const TENANT_ID = "tenant-acme";
const SUPPLIER_ID = "supplier-bob";
const STORE_EAST = "store-nyc";
const STORE_WEST = "store-lax";
const ACTOR_ID = "admin-1";

const TENANT_CTX: TenantTimezoneContext = {
  tenantId: TENANT_ID,
  tenantDefaultTimezone: "UTC",
};

const BASE_SUPPLIER_CTX: SupplierTimezoneContext = {
  supplierId: SUPPLIER_ID,
  stores: {},
};

function makeAuditLogger() {
  const entries: any[] = [];
  const logger = {
    log: jest.fn().mockImplementation(async () => {
      entries.push({});
    }),
  } as unknown as AuditLogger;
  return { logger, entries };
}

function makeDeps(supplier: SupplierTimezoneContext = BASE_SUPPLIER_CTX, tenant: TenantTimezoneContext = TENANT_CTX) {
  const { logger, entries } = makeAuditLogger();
  const deps = createInMemoryTimezoneResolverDeps({
    suppliers: { [SUPPLIER_ID]: supplier },
    tenants: { [TENANT_ID]: tenant },
    auditLogger: logger,
  });
  return { deps, logger, entries, service: new TimezoneResolverService(deps) };
}

describe("isValidIanaTimezone", () => {
  it("accepts valid IANA zones", () => {
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("Europe/London")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);
    expect(isValidIanaTimezone("Asia/Kolkata")).toBe(true);
  });

  it("rejects invalid strings", () => {
    expect(isValidIanaTimezone("Not/A/Zone")).toBe(false);
    expect(isValidIanaTimezone("")).toBe(false);
    expect(isValidIanaTimezone("  ")).toBe(false);
    expect(isValidIanaTimezone("FAKE/ZONE")).toBe(false);
  });
});

describe("TimezoneResolverService.resolveTimezone fallback chain", () => {
  it("falls back to tenant default when no overrides exist", async () => {
    const { service } = makeDeps();
    const r = await service.resolveTimezone({
      supplierId: SUPPLIER_ID,
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
    });
    expect(r.timezone).toBe("UTC");
    expect(r.source).toBe("tenant");
    expect(r.storeId).toBeUndefined();
  });

  it("uses supplier default over tenant default", async () => {
    const supplier: SupplierTimezoneContext = {
      ...BASE_SUPPLIER_CTX,
      supplierDefaultTimezone: {
        timezone: "Europe/Berlin",
        setAt: new Date().toISOString(),
        setBy: ACTOR_ID,
      },
    };
    const { service } = makeDeps(supplier);
    const r = await service.resolveTimezone({
      supplierId: SUPPLIER_ID,
      tenantId: TENANT_ID,
    });
    expect(r.timezone).toBe("Europe/Berlin");
    expect(r.source).toBe("supplier");
  });

  it("uses store override over supplier and tenant", async () => {
    const supplier: SupplierTimezoneContext = {
      ...BASE_SUPPLIER_CTX,
      supplierDefaultTimezone: {
        timezone: "Europe/Berlin",
        setAt: new Date().toISOString(),
        setBy: ACTOR_ID,
      },
      stores: {
        [STORE_EAST]: {
          storeId: STORE_EAST,
          timezoneOverride: {
            timezone: "America/New_York",
            setAt: new Date().toISOString(),
            setBy: ACTOR_ID,
            reason: "East coast flagship",
          },
          regionCodes: ["US-NY", "US-NJ"],
        },
      },
    };
    const { service } = makeDeps(supplier);
    const r = await service.resolveTimezone({
      supplierId: SUPPLIER_ID,
      tenantId: TENANT_ID,
      storeId: STORE_EAST,
    });
    expect(r.timezone).toBe("America/New_York");
    expect(r.source).toBe("store");
    expect(r.storeId).toBe(STORE_EAST);
    expect(r.reason).toBe("East coast flagship");
  });

  it("ignores store override for unknown store id", async () => {
    const supplier: SupplierTimezoneContext = {
      ...BASE_SUPPLIER_CTX,
      supplierDefaultTimezone: {
        timezone: "Europe/Berlin",
        setAt: new Date().toISOString(),
        setBy: ACTOR_ID,
      },
      stores: {},
    };
    const { service } = makeDeps(supplier);
    const r = await service.resolveTimezone({
      supplierId: SUPPLIER_ID,
      tenantId: TENANT_ID,
      storeId: "nonexistent",
    });
    expect(r.source).toBe("supplier");
    expect(r.timezone).toBe("Europe/Berlin");
  });

  it("emits audit event with candidate chain", async () => {
    const supplier: SupplierTimezoneContext = {
      ...BASE_SUPPLIER_CTX,
      supplierDefaultTimezone: {
        timezone: "Europe/Berlin",
        setAt: new Date().toISOString(),
        setBy: ACTOR_ID,
      },
      stores: {
        [STORE_WEST]: {
          storeId: STORE_WEST,
          timezoneOverride: {
            timezone: "America/Los_Angeles",
            setAt: new Date().toISOString(),
            setBy: ACTOR_ID,
          },
        },
      },
    };
    const { service, logger } = makeDeps(supplier);
    await service.resolveTimezone({
      supplierId: SUPPLIER_ID,
      tenantId: TENANT_ID,
      storeId: STORE_WEST,
      actorId: ACTOR_ID,
    });
    expect(logger.log).toHaveBeenCalled();
    const call = (logger.log as jest.Mock).mock.calls.find(
      (c: any[]) => c[0] === "timezone.resolved",
    );
    expect(call).toBeTruthy();
    const payload = call[1];
    expect(payload.context.resolvedTimezone).toBe("America/Los_Angeles");
    expect(payload.context.source).toBe("store");
    expect(payload.context.candidates.storeTimezone).toBe("America/Los_Angeles");
    expect(payload.context.candidates.supplierTimezone).toBe("Europe/Berlin");
    expect(payload.context.candidates.tenantTimezone).toBe("UTC");
  });

  it("rejects when tenant context is missing", async () => {
    const { service, deps } = makeDeps();
    delete deps.tenants[TENANT_ID];
    await expect(
      service.resolveTimezone({ supplierId: SUPPLIER_ID, tenantId: TENANT_ID }),
    ).rejects.toBeInstanceOf(TimezoneResolverError);
  });

  it("rejects invalid supplier timezone override", async () => {
    const supplier: SupplierTimezoneContext = {
      ...BASE_SUPPLIER_CTX,
      supplierDefaultTimezone: {
        timezone: "FAKE/ZONE",
        setAt: new Date().toISOString(),
        setBy: ACTOR_ID,
      },
    };
    const { service } = makeDeps(supplier);
    await expect(
      service.resolveTimezone({ supplierId: SUPPLIER_ID, tenantId: TENANT_ID }),
    ).rejects.toBeInstanceOf(InvalidTimezoneError);
  });

  it("requires non-empty supplierId and tenantId", async () => {
    const { service } = makeDeps();
    await expect(
      service.resolveTimezone({ supplierId: "", tenantId: TENANT_ID }),
    ).rejects.toBeInstanceOf(TimezoneResolverError);
    await expect(
      service.resolveTimezone({ supplierId: SUPPLIER_ID, tenantId: "  " }),
    ).rejects.toBeInstanceOf(TimezoneResolverError);
  });
});

describe("TimezoneResolverService mutation helpers", () => {
  it("setStoreTimezoneOverride validates timezone", async () => {
    const { service } = makeDeps();
    await expect(
      service.setStoreTimezoneOverride({
        supplierId: SUPPLIER_ID,
        storeId: STORE_EAST,
        timezone: "NOT/A/ZONE",
        actorId: ACTOR_ID,
        currentContext: BASE_SUPPLIER_CTX,
      }),
    ).rejects.toBeInstanceOf(InvalidTimezoneError);
  });

  it("setStoreTimezoneOverride returns updated context and audits", async () => {
    const { service, logger } = makeDeps();
    const result = await service.setStoreTimezoneOverride({
      supplierId: SUPPLIER_ID,
      storeId: STORE_EAST,
      timezone: "America/New_York",
      actorId: ACTOR_ID,
      reason: "Grand opening",
      currentContext: BASE_SUPPLIER_CTX,
    });
    expect(result.context.stores[STORE_EAST].timezoneOverride?.timezone).toBe("America/New_York");
    expect(result.context.stores[STORE_EAST].timezoneOverride?.reason).toBe("Grand opening");
    expect(logger.log).toHaveBeenCalledWith(
      "timezone.store_override_set",
      expect.objectContaining({
        context: expect.objectContaining({
          newTimezone: "America/New_York",
        }),
      }),
      expect.anything(),
    );
  });

  it("setSupplierDefaultTimezone updates supplier default", async () => {
    const { service } = makeDeps();
    const updated = await service.setSupplierDefaultTimezone({
      supplierId: SUPPLIER_ID,
      timezone: "Europe/Paris",
      actorId: ACTOR_ID,
      currentContext: BASE_SUPPLIER_CTX,
    });
    expect(updated.supplierDefaultTimezone?.timezone).toBe("Europe/Paris");
  });

  it("clearStoreTimezoneOverride is idempotent", async () => {
    const withStore: SupplierTimezoneContext = {
      ...BASE_SUPPLIER_CTX,
      stores: {
        [STORE_EAST]: {
          storeId: STORE_EAST,
          timezoneOverride: {
            timezone: "America/New_York",
            setAt: new Date().toISOString(),
            setBy: ACTOR_ID,
          },
        },
      },
    };
    const { service } = makeDeps(withStore);
    const afterFirst = await service.clearStoreTimezoneOverride({
      supplierId: SUPPLIER_ID,
      storeId: STORE_EAST,
      actorId: ACTOR_ID,
      currentContext: withStore,
    });
    expect(afterFirst.stores[STORE_EAST].timezoneOverride).toBeUndefined();

    const afterSecond = await service.clearStoreTimezoneOverride({
      supplierId: SUPPLIER_ID,
      storeId: STORE_EAST,
      actorId: ACTOR_ID,
      currentContext: afterFirst,
    });
    expect(afterSecond.stores[STORE_EAST].timezoneOverride).toBeUndefined();
  });
});

describe("resolveTimezoneSync", () => {
  it("applies same fallback chain without IO", () => {
    const supplier: SupplierTimezoneContext = {
      ...BASE_SUPPLIER_CTX,
      stores: {
        [STORE_WEST]: {
          storeId: STORE_WEST,
          timezoneOverride: {
            timezone: "America/Los_Angeles",
            setAt: new Date().toISOString(),
            setBy: ACTOR_ID,
          },
        },
      },
    };
    const { service } = makeDeps();
    const r = service.resolveTimezoneSync({
      supplierContext: supplier,
      tenantContext: TENANT_CTX,
      storeId: STORE_WEST,
    });
    expect(r.timezone).toBe("America/Los_Angeles");
    expect(r.source).toBe("store");
  });
});

describe("region helpers", () => {
  it("getRegionsForStore returns empty for missing store", () => {
    const { service } = makeDeps();
    expect(service.getRegionsForStore({ storeId: "nope" })).toEqual([]);
  });

  it("getRegionsForStore returns store region codes", () => {
    const supplier: SupplierTimezoneContext = {
      ...BASE_SUPPLIER_CTX,
      stores: {
        [STORE_EAST]: {
          storeId: STORE_EAST,
          regionCodes: ["US-NY", "US-NJ", "US-CT"],
        },
      },
    };
    const { service } = makeDeps(supplier);
    expect(service.getRegionsForStore({ supplierContext: supplier, storeId: STORE_EAST })).toEqual([
      "US-NY",
      "US-NJ",
      "US-CT",
    ]);
  });

  it("getAllRegionsForSupplier deduplicates across stores", () => {
    const supplier: SupplierTimezoneContext = {
      ...BASE_SUPPLIER_CTX,
      stores: {
        a: { storeId: "a", regionCodes: ["US-CA", "US-NV"] },
        b: { storeId: "b", regionCodes: ["US-NV", "US-AZ"] },
      },
    };
    const { service } = makeDeps(supplier);
    const regions = service.getAllRegionsForSupplier(supplier).sort();
    expect(regions).toEqual(["US-AZ", "US-CA", "US-NV"]);
  });
});
