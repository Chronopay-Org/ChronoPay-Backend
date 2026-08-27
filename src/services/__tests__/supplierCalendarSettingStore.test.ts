// @ts-nocheck
import { SupplierCalendarSettingStore } from "../supplierCalendarSettingStore.js";

describe("SupplierCalendarSettingStore", () => {
  beforeEach(() => {
    SupplierCalendarSettingStore.clear();
  });

  describe("isEnabled", () => {
    it("should return false for an unknown supplier (opt-out by default)", () => {
      expect(SupplierCalendarSettingStore.isEnabled("unknown-supplier")).toBe(false);
    });

    it("should return false for an empty supplierId", () => {
      expect(SupplierCalendarSettingStore.isEnabled("")).toBe(false);
    });

    it("should return false for a whitespace-only supplierId", () => {
      expect(SupplierCalendarSettingStore.isEnabled("   ")).toBe(false);
    });

    it("should return false for a non-string supplierId", () => {
      expect(SupplierCalendarSettingStore.isEnabled(null as any)).toBe(false);
      expect(SupplierCalendarSettingStore.isEnabled(undefined as any)).toBe(false);
      expect(SupplierCalendarSettingStore.isEnabled(123 as any)).toBe(false);
    });

    it("should return true after enabling a supplier", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true);
      expect(SupplierCalendarSettingStore.isEnabled("supplier-1")).toBe(true);
    });

    it("should return false after disabling a supplier", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true);
      SupplierCalendarSettingStore.setEnabled("supplier-1", false);
      expect(SupplierCalendarSettingStore.isEnabled("supplier-1")).toBe(false);
    });

    it("should return false after removing a supplier", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true);
      SupplierCalendarSettingStore.remove("supplier-1");
      expect(SupplierCalendarSettingStore.isEnabled("supplier-1")).toBe(false);
    });

    it("should trim supplierId before lookup", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true);
      expect(SupplierCalendarSettingStore.isEnabled("  supplier-1  ")).toBe(true);
    });
  });

  describe("setEnabled", () => {
    it("should create a new setting when enabling", () => {
      const setting = SupplierCalendarSettingStore.setEnabled("supplier-1", true);

      expect(setting.supplierId).toBe("supplier-1");
      expect(setting.enabled).toBe(true);
      expect(setting.updatedAt).toBeDefined();
      expect(new Date(setting.updatedAt).toISOString()).toBe(setting.updatedAt);
    });

    it("should create a new setting when disabling", () => {
      const setting = SupplierCalendarSettingStore.setEnabled("supplier-1", false);

      expect(setting.supplierId).toBe("supplier-1");
      expect(setting.enabled).toBe(false);
    });

    it("should upsert an existing setting", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true);
      const updated = SupplierCalendarSettingStore.setEnabled("supplier-1", false);

      expect(updated.enabled).toBe(false);
      expect(SupplierCalendarSettingStore.isEnabled("supplier-1")).toBe(false);
    });

    it("should throw for empty supplierId", () => {
      expect(() => SupplierCalendarSettingStore.setEnabled("", true)).toThrow(
        "supplierId must be a non-empty string"
      );
    });

    it("should throw for whitespace-only supplierId", () => {
      expect(() => SupplierCalendarSettingStore.setEnabled("   ", true)).toThrow(
        "supplierId must be a non-empty string"
      );
    });

    it("should trim supplierId", () => {
      const setting = SupplierCalendarSettingStore.setEnabled("  supplier-1  ", true);
      expect(setting.supplierId).toBe("supplier-1");
    });

    it("should store optional webhookUrl", () => {
      const setting = SupplierCalendarSettingStore.setEnabled("supplier-1", true, {
        webhookUrl: "https://example.com/hook",
      });

      expect(setting.webhookUrl).toBe("https://example.com/hook");
    });

    it("should store optional signingSecret", () => {
      const setting = SupplierCalendarSettingStore.setEnabled("supplier-1", true, {
        signingSecret: "secret-key",
      });

      expect(setting.signingSecret).toBe("secret-key");
    });

    it("should preserve existing webhookUrl when not updating", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true, {
        webhookUrl: "https://example.com/hook",
      });

      const updated = SupplierCalendarSettingStore.setEnabled("supplier-1", false);
      expect(updated.webhookUrl).toBe("https://example.com/hook");
    });

    it("should allow overriding webhookUrl", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true, {
        webhookUrl: "https://old.example.com/hook",
      });

      const updated = SupplierCalendarSettingStore.setEnabled("supplier-1", true, {
        webhookUrl: "https://new.example.com/hook",
      });

      expect(updated.webhookUrl).toBe("https://new.example.com/hook");
    });

    it("should return a copy (not a reference to the internal store)", () => {
      const setting = SupplierCalendarSettingStore.setEnabled("supplier-1", true);
      setting.enabled = false; // Mutate the returned object

      // Internal store should be unaffected
      expect(SupplierCalendarSettingStore.isEnabled("supplier-1")).toBe(true);
    });
  });

  describe("getSetting", () => {
    it("should return null for an unknown supplier", () => {
      expect(SupplierCalendarSettingStore.getSetting("unknown")).toBeNull();
    });

    it("should return null for an empty supplierId", () => {
      expect(SupplierCalendarSettingStore.getSetting("")).toBeNull();
    });

    it("should return null for a non-string supplierId", () => {
      expect(SupplierCalendarSettingStore.getSetting(null as any)).toBeNull();
    });

    it("should return the full setting after setEnabled", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true, {
        webhookUrl: "https://example.com/hook",
        signingSecret: "secret",
      });

      const setting = SupplierCalendarSettingStore.getSetting("supplier-1");

      expect(setting).not.toBeNull();
      expect(setting!.supplierId).toBe("supplier-1");
      expect(setting!.enabled).toBe(true);
      expect(setting!.webhookUrl).toBe("https://example.com/hook");
      expect(setting!.signingSecret).toBe("secret");
    });

    it("should return a copy (not a reference to the internal store)", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true);
      const setting = SupplierCalendarSettingStore.getSetting("supplier-1");

      setting!.enabled = false; // Mutate the returned object

      // Internal store should be unaffected
      expect(SupplierCalendarSettingStore.isEnabled("supplier-1")).toBe(true);
    });
  });

  describe("remove", () => {
    it("should return true when removing an existing supplier", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true);
      expect(SupplierCalendarSettingStore.remove("supplier-1")).toBe(true);
    });

    it("should return false when removing a non-existent supplier", () => {
      expect(SupplierCalendarSettingStore.remove("unknown")).toBe(false);
    });

    it("should return false for empty supplierId", () => {
      expect(SupplierCalendarSettingStore.remove("")).toBe(false);
    });

    it("should return false for non-string supplierId", () => {
      expect(SupplierCalendarSettingStore.remove(null as any)).toBe(false);
    });

    it("should make isEnabled return false after removal", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true);
      SupplierCalendarSettingStore.remove("supplier-1");
      expect(SupplierCalendarSettingStore.isEnabled("supplier-1")).toBe(false);
    });

    it("should make getSetting return null after removal", () => {
      SupplierCalendarSettingStore.setEnabled("supplier-1", true);
      SupplierCalendarSettingStore.remove("supplier-1");
      expect(SupplierCalendarSettingStore.getSetting("supplier-1")).toBeNull();
    });
  });

  describe("listEnabled", () => {
    it("should return empty array when no suppliers are enabled", () => {
      expect(SupplierCalendarSettingStore.listEnabled()).toEqual([]);
    });

    it("should return only enabled suppliers", () => {
      SupplierCalendarSettingStore.setEnabled("s1", true);
      SupplierCalendarSettingStore.setEnabled("s2", false);
      SupplierCalendarSettingStore.setEnabled("s3", true);

      const enabled = SupplierCalendarSettingStore.listEnabled();
      expect(enabled).toHaveLength(2);
      expect(enabled.map((s) => s.supplierId)).toEqual(["s1", "s3"]);
    });

    it("should return copies (not references to internal store)", () => {
      SupplierCalendarSettingStore.setEnabled("s1", true);
      const enabled = SupplierCalendarSettingStore.listEnabled();

      enabled[0].enabled = false; // Mutate

      // Internal store should be unaffected
      expect(SupplierCalendarSettingStore.isEnabled("s1")).toBe(true);
    });

    it("should return all enabled suppliers after disabling one", () => {
      SupplierCalendarSettingStore.setEnabled("s1", true);
      SupplierCalendarSettingStore.setEnabled("s2", true);
      SupplierCalendarSettingStore.setEnabled("s2", false);

      const enabled = SupplierCalendarSettingStore.listEnabled();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].supplierId).toBe("s1");
    });
  });

  describe("clear", () => {
    it("should remove all settings", () => {
      SupplierCalendarSettingStore.setEnabled("s1", true);
      SupplierCalendarSettingStore.setEnabled("s2", true);

      SupplierCalendarSettingStore.clear();

      expect(SupplierCalendarSettingStore.size()).toBe(0);
      expect(SupplierCalendarSettingStore.isEnabled("s1")).toBe(false);
      expect(SupplierCalendarSettingStore.isEnabled("s2")).toBe(false);
    });

    it("should be safe to call on an empty store", () => {
      expect(() => SupplierCalendarSettingStore.clear()).not.toThrow();
    });
  });

  describe("size", () => {
    it("should return 0 for an empty store", () => {
      expect(SupplierCalendarSettingStore.size()).toBe(0);
    });

    it("should return the correct count", () => {
      SupplierCalendarSettingStore.setEnabled("s1", true);
      SupplierCalendarSettingStore.setEnabled("s2", false);
      SupplierCalendarSettingStore.setEnabled("s3", true);

      expect(SupplierCalendarSettingStore.size()).toBe(3);
    });

    it("should decrease after removal", () => {
      SupplierCalendarSettingStore.setEnabled("s1", true);
      SupplierCalendarSettingStore.setEnabled("s2", true);

      SupplierCalendarSettingStore.remove("s1");
      expect(SupplierCalendarSettingStore.size()).toBe(1);
    });
  });
});
