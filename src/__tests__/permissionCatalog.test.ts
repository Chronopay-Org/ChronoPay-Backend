import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  buildPermissionCatalog,
  matchesGrant,
  hasPermission,
  getEffectivePermissions,
  type PermissionCatalog,
} from "../services/permissionCatalog.js";

describe("Permission Catalog", () => {
  let catalog: PermissionCatalog;

  beforeEach(() => {
    catalog = buildPermissionCatalog();
  });

  describe("buildPermissionCatalog", () => {
    it("should load permissions from configuration", () => {
      expect(catalog.permissions.size).toBeGreaterThan(0);
      expect(catalog.permissions.has("bookings:create")).toBe(true);
      expect(catalog.permissions.has("users:read")).toBe(true);
    });

    it("should load grants by role", () => {
      expect(catalog.grantsByRole.size).toBeGreaterThan(0);
      expect(catalog.grantsByRole.has("admin")).toBe(true);
      expect(catalog.grantsByRole.has("customer")).toBe(true);
    });

    it("should normalize permission and role names", () => {
      expect(catalog.permissions.has("bookings:create")).toBe(true);
      expect(catalog.grantsByRole.has("admin")).toBe(true);
    });
  });

  describe("matchesGrant", () => {
    it("should match full wildcard grant", () => {
      expect(matchesGrant("bookings:create", "*")).toBe(true);
      expect(matchesGrant("users:delete", "*")).toBe(true);
      expect(matchesGrant("anything:action", "*")).toBe(true);
    });

    it("should match resource wildcard grant", () => {
      expect(matchesGrant("bookings:create", "bookings:*")).toBe(true);
      expect(matchesGrant("bookings:read", "bookings:*")).toBe(true);
      expect(matchesGrant("bookings:delete", "bookings:*")).toBe(true);
    });

    it("should not match different resource wildcard", () => {
      expect(matchesGrant("users:create", "bookings:*")).toBe(false);
      expect(matchesGrant("slots:read", "bookings:*")).toBe(false);
    });

    it("should match exact permission", () => {
      expect(matchesGrant("bookings:create", "bookings:create")).toBe(true);
      expect(matchesGrant("users:read", "users:read")).toBe(true);
    });

    it("should not match different exact permission", () => {
      expect(matchesGrant("bookings:create", "bookings:read")).toBe(false);
      expect(matchesGrant("users:create", "users:delete")).toBe(false);
    });

    it("should handle case insensitivity", () => {
      expect(matchesGrant("Bookings:Create", "bookings:*")).toBe(true);
      expect(matchesGrant("USERS:READ", "users:read")).toBe(true);
      expect(matchesGrant("slots:list", "SLOTS:*")).toBe(true);
    });

    it("should handle whitespace in permissions", () => {
      expect(matchesGrant(" bookings:create ", "bookings:*")).toBe(true);
      expect(matchesGrant("users:read", " users:read ")).toBe(true);
    });

    it("should not match partial resource names", () => {
      expect(matchesGrant("bookings:create", "booking:*")).toBe(false);
      expect(matchesGrant("booking:create", "bookings:*")).toBe(false);
    });

    it("should not match malformed permissions", () => {
      expect(matchesGrant("bookings", "bookings:*")).toBe(false);
      expect(matchesGrant("bookings:create:extra", "bookings:*")).toBe(false);
    });
  });

  describe("hasPermission", () => {
    it("should grant permission with full wildcard", () => {
      expect(hasPermission(catalog, "admin", "bookings:create")).toBe(true);
      expect(hasPermission(catalog, "admin", "users:delete")).toBe(true);
      expect(hasPermission(catalog, "admin", "system:configure")).toBe(true);
    });

    it("should grant permission with resource wildcard", () => {
      expect(hasPermission(catalog, "professional", "slots:create")).toBe(true);
      expect(hasPermission(catalog, "professional", "slots:read")).toBe(true);
      expect(hasPermission(catalog, "professional", "slots:delete")).toBe(true);
    });

    it("should grant permission with exact match", () => {
      expect(hasPermission(catalog, "customer", "bookings:create")).toBe(true);
      expect(hasPermission(catalog, "customer", "bookings:read")).toBe(true);
    });

    it("should deny permission not in grants", () => {
      expect(hasPermission(catalog, "customer", "users:delete")).toBe(false);
      expect(hasPermission(catalog, "customer", "system:configure")).toBe(false);
      expect(hasPermission(catalog, "auditor", "bookings:create")).toBe(false);
    });

    it("should deny permission for unknown role", () => {
      expect(hasPermission(catalog, "unknown", "bookings:read")).toBe(false);
    });

    it("should deny permission for unknown permission", () => {
      expect(hasPermission(catalog, "admin", "unknown:permission")).toBe(false);
    });

    it("should handle case insensitive role and permission", () => {
      expect(hasPermission(catalog, "ADMIN", "bookings:create")).toBe(true);
      expect(hasPermission(catalog, "Customer", "BOOKINGS:READ")).toBe(true);
    });

    it("should correctly apply support permissions", () => {
      expect(hasPermission(catalog, "support", "bookings:create")).toBe(true);
      expect(hasPermission(catalog, "support", "bookings:read")).toBe(true);
      expect(hasPermission(catalog, "support", "bookings:cancel")).toBe(true);
      expect(hasPermission(catalog, "support", "users:delete")).toBe(false);
    });

    it("should correctly apply auditor permissions", () => {
      expect(hasPermission(catalog, "auditor", "audit:read")).toBe(true);
      expect(hasPermission(catalog, "auditor", "audit:export")).toBe(true);
      expect(hasPermission(catalog, "auditor", "reports:read")).toBe(true);
      expect(hasPermission(catalog, "auditor", "bookings:create")).toBe(false);
    });
  });

  describe("getEffectivePermissions", () => {
    it("should return all permissions for admin with full wildcard", () => {
      const permissions = getEffectivePermissions(catalog, "admin");
      expect(permissions.size).toBe(catalog.permissions.size);
      expect([...permissions]).toEqual([...catalog.permissions]);
    });

    it("should return expanded permissions for resource wildcard", () => {
      const permissions = getEffectivePermissions(catalog, "professional");
      expect(permissions.has("slots:create")).toBe(true);
      expect(permissions.has("slots:read")).toBe(true);
      expect(permissions.has("slots:update")).toBe(true);
      expect(permissions.has("slots:delete")).toBe(true);
      expect(permissions.has("slots:list")).toBe(true);
      expect(permissions.has("bookings:read")).toBe(true);
      expect(permissions.has("bookings:update")).toBe(true);
    });

    it("should return only granted exact permissions", () => {
      const permissions = getEffectivePermissions(catalog, "customer");
      expect(permissions.has("bookings:create")).toBe(true);
      expect(permissions.has("bookings:read")).toBe(true);
      expect(permissions.has("bookings:cancel")).toBe(true);
      expect(permissions.has("slots:read")).toBe(true);
      expect(permissions.has("slots:list")).toBe(true);
      expect(permissions.has("users:read")).toBe(true);
      
      // Should not have these
      expect(permissions.has("bookings:delete")).toBe(false);
      expect(permissions.has("users:delete")).toBe(false);
      expect(permissions.has("system:configure")).toBe(false);
    });

    it("should return empty set for unknown role", () => {
      const permissions = getEffectivePermissions(catalog, "unknown");
      expect(permissions.size).toBe(0);
    });

    it("should handle overlapping grants correctly", () => {
      const permissions = getEffectivePermissions(catalog, "support");
      
      // Should have bookings:* permissions
      expect(permissions.has("bookings:create")).toBe(true);
      expect(permissions.has("bookings:read")).toBe(true);
      
      // Should have exact slot permissions
      expect(permissions.has("slots:read")).toBe(true);
      expect(permissions.has("slots:list")).toBe(true);
      
      // Should NOT have other slot permissions
      expect(permissions.has("slots:create")).toBe(false);
      expect(permissions.has("slots:delete")).toBe(false);
    });

    it("should handle case insensitive roles", () => {
      const permissions1 = getEffectivePermissions(catalog, "admin");
      const permissions2 = getEffectivePermissions(catalog, "ADMIN");
      const permissions3 = getEffectivePermissions(catalog, "Admin");
      
      expect(permissions1.size).toBe(permissions2.size);
      expect(permissions2.size).toBe(permissions3.size);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty grants for a role", () => {
      const testCatalog: PermissionCatalog = {
        permissions: catalog.permissions,
        grantsByRole: new Map([["empty_role", new Set()]]),
      };

      expect(hasPermission(testCatalog, "empty_role", "bookings:read")).toBe(false);
      const permissions = getEffectivePermissions(testCatalog, "empty_role");
      expect(permissions.size).toBe(0);
    });

    it("should handle multiple overlapping wildcard grants", () => {
      const testCatalog: PermissionCatalog = {
        permissions: catalog.permissions,
        grantsByRole: new Map([
          ["multi_wildcard", new Set(["bookings:*", "slots:*", "*"])],
        ]),
      };

      const permissions = getEffectivePermissions(testCatalog, "multi_wildcard");
      expect(permissions.size).toBe(catalog.permissions.size);
    });

    it("should handle grants that mix wildcards and exact permissions", () => {
      const permissions = getEffectivePermissions(catalog, "support");
      
      // Has bookings:* wildcard
      expect(permissions.has("bookings:create")).toBe(true);
      expect(permissions.has("bookings:read")).toBe(true);
      
      // Has specific slot permissions
      expect(permissions.has("slots:read")).toBe(true);
      expect(permissions.has("slots:list")).toBe(true);
    });

    it("should not be confused by similar permission names", () => {
      expect(matchesGrant("bookings:create", "booking:*")).toBe(false);
      expect(matchesGrant("user:read", "users:*")).toBe(false);
    });

    it("should handle revoke scenario (permission removed mid-request)", () => {
      // Initial check - has permission
      expect(hasPermission(catalog, "professional", "slots:create")).toBe(true);
      
      // Simulate revoke by creating new catalog without that grant
      const revokedCatalog: PermissionCatalog = {
        permissions: catalog.permissions,
        grantsByRole: new Map([
          ["professional", new Set(["bookings:read", "users:read"])],
        ]),
      };
      
      // After revoke - no permission
      expect(hasPermission(revokedCatalog, "professional", "slots:create")).toBe(false);
    });

    it("should handle wildcard misuse attempts", () => {
      // Wildcards only work at end of resource
      expect(matchesGrant("bookings:create", "*:create")).toBe(false);
      expect(matchesGrant("bookings:create", "book*:create")).toBe(false);
      expect(matchesGrant("bookings:create", "bookings:*:extra")).toBe(false);
    });

    it("should validate that permissions exist in catalog", () => {
      expect(hasPermission(catalog, "admin", "nonexistent:permission")).toBe(false);
      expect(hasPermission(catalog, "admin", "fake:action")).toBe(false);
    });
  });
});
