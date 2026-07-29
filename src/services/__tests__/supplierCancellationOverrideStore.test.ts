import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  InMemorySupplierCancellationOverrideStore,
  SupplierCancellationOverride,
} from "../supplierCancellationOverrideStore.js";
import { ProratedCancellationTerms } from "../../modules/booking-intents/booking-intent-repository.js";
import { AuditLogger } from "../auditLogger.js";

const VALID_TERMS: ProratedCancellationTerms = {
  tiers: [
    {
      minHoursUntilStart: 24,
      refundRatio: 1.0,
    },
    {
      minHoursUntilStart: 0,
      maxHoursUntilStart: 24,
      refundRatio: 0.5,
    },
  ],
};

describe("InMemorySupplierCancellationOverrideStore", () => {
  let store: InMemorySupplierCancellationOverrideStore;
  let auditLogger: jest.Mocked<AuditLogger>;

  beforeEach(() => {
    auditLogger = {
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogger>;
    store = new InMemorySupplierCancellationOverrideStore({
      auditLogger,
      nowIso: () => "2026-07-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    store.reset();
  });

  describe("getOverride", () => {
    it("returns undefined for non-existent supplier", () => {
      expect(store.getOverride("nonexistent")).toBeUndefined();
    });

    it("returns override after set", async () => {
      await store.setOverride("supplier-1", VALID_TERMS, "admin-1");
      const result = store.getOverride("supplier-1");
      expect(result).toBeDefined();
      expect(result!.supplierId).toBe("supplier-1");
      expect(result!.terms.tiers).toHaveLength(2);
      expect(result!.createdBy).toBe("admin-1");
      expect(result!.updatedBy).toBe("admin-1");
    });
  });

  describe("listOverrides", () => {
    it("returns empty array when no overrides exist", () => {
      expect(store.listOverrides()).toEqual([]);
    });

    it("returns all overrides sorted by supplierId", async () => {
      await store.setOverride("supplier-b", VALID_TERMS, "admin-1");
      await store.setOverride("supplier-a", VALID_TERMS, "admin-1");

      const list = store.listOverrides();
      expect(list).toHaveLength(2);
      expect(list[0].supplierId).toBe("supplier-a");
      expect(list[1].supplierId).toBe("supplier-b");
    });
  });

  describe("setOverride", () => {
    it("creates a new override", async () => {
      const result = await store.setOverride("supplier-1", VALID_TERMS, "admin-1", "Custom terms");

      expect(result.supplierId).toBe("supplier-1");
      expect(result.createdAt).toBe("2026-07-01T00:00:00.000Z");
      expect(result.updatedAt).toBe("2026-07-01T00:00:00.000Z");
      expect(result.createdBy).toBe("admin-1");
      expect(result.updatedBy).toBe("admin-1");
      expect(result.description).toBe("Custom terms");
    });

    it("updates an existing override preserving created fields", async () => {
      await store.setOverride("supplier-1", VALID_TERMS, "admin-1");
      const updatedTerms: ProratedCancellationTerms = {
        tiers: [{ minHoursUntilStart: 0, refundRatio: 0.0 }],
      };

      const result = await store.setOverride(
        "supplier-1",
        updatedTerms,
        "admin-2",
        "Updated terms",
      );

      expect(result.createdBy).toBe("admin-1");
      expect(result.updatedBy).toBe("admin-2");
      expect(result.createdAt).toBe("2026-07-01T00:00:00.000Z");
      expect(result.terms.tiers).toHaveLength(1);
      expect(result.description).toBe("Updated terms");
    });

    it("audits creation", async () => {
      await store.setOverride("supplier-1", VALID_TERMS, "admin-1");
      expect(auditLogger.log).toHaveBeenCalledWith(
        "cancellation_policy.supplier_override",
        expect.objectContaining({
          context: expect.objectContaining({
            supplierId: "supplier-1",
            action: "created",
            changedBy: "admin-1",
          }),
        }),
        expect.anything(),
      );
    });

    it("audits updates", async () => {
      await store.setOverride("supplier-1", VALID_TERMS, "admin-1");
      (auditLogger.log as jest.Mock).mockClear();

      const newTerms: ProratedCancellationTerms = {
        tiers: [{ minHoursUntilStart: 0, refundRatio: 0.0 }],
      };
      await store.setOverride("supplier-1", newTerms, "admin-2");

      expect(auditLogger.log).toHaveBeenCalledWith(
        "cancellation_policy.supplier_override",
        expect.objectContaining({
          context: expect.objectContaining({
            action: "updated",
            previousTerms: expect.objectContaining({ tiers: expect.any(Array) }),
            newTerms: expect.objectContaining({ tiers: [{ minHoursUntilStart: 0, refundRatio: 0 }] }),
          }),
        }),
        expect.anything(),
      );
    });

    it("rejects empty supplierId", async () => {
      await expect(
        store.setOverride("", VALID_TERMS, "admin-1"),
      ).rejects.toThrow("supplierId must be a non-empty string");
    });

    it("rejects invalid terms", async () => {
      await expect(
        store.setOverride("supplier-1", { tiers: [] }, "admin-1"),
      ).rejects.toThrow("ProratedCancellationTerms must have at least one tier");
    });
  });

  describe("deleteOverride", () => {
    it("returns false for non-existent supplier", async () => {
      const result = await store.deleteOverride("nonexistent", "admin-1");
      expect(result).toBe(false);
    });

    it("deletes existing override and audits", async () => {
      await store.setOverride("supplier-1", VALID_TERMS, "admin-1");
      (auditLogger.log as jest.Mock).mockClear();

      const result = await store.deleteOverride("supplier-1", "admin-2");
      expect(result).toBe(true);
      expect(store.getOverride("supplier-1")).toBeUndefined();

      expect(auditLogger.log).toHaveBeenCalledWith(
        "cancellation_policy.supplier_override_deleted",
        expect.objectContaining({
          context: expect.objectContaining({
            supplierId: "supplier-1",
            action: "deleted",
            changedBy: "admin-2",
          }),
        }),
        expect.anything(),
      );
    });
  });

  describe("seed", () => {
    it("loads initial overrides from seed", () => {
      const seeded: SupplierCancellationOverride[] = [
        {
          supplierId: "supplier-seeded",
          terms: VALID_TERMS,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          createdBy: "seed",
          updatedBy: "seed",
        },
      ];

      const seededStore = new InMemorySupplierCancellationOverrideStore({
        seed: seeded,
        nowIso: () => "2026-07-01T00:00:00.000Z",
      });

      expect(seededStore.getOverride("supplier-seeded")).toBeDefined();
      expect(seededStore.listOverrides()).toHaveLength(1);
    });
  });
});
