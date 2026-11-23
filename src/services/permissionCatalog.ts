import fs from "fs";
import { defaultAuditLogger } from "./auditLogger.js";

const PERMISSIONS_CONFIG_URL = new URL("../config/permissions.json", import.meta.url);
const GRANTS_CONFIG_URL = new URL("../config/permission-grants.json", import.meta.url);

export type Permission = string;
export type PermissionGrant = string;

interface PermissionsConfig {
  permissions: Permission[];
}

interface GrantsConfig {
  grants: Record<string, PermissionGrant[]>;
}

export interface PermissionCatalog {
  permissions: ReadonlySet<Permission>;
  grantsByRole: ReadonlyMap<string, ReadonlySet<PermissionGrant>>;
}

/**
 * Normalizes a permission or grant string to lowercase and trims whitespace
 */
function normalizePermission(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

/**
 * Normalizes a list of permission strings
 */
function normalizePermissionList(values: readonly string[]): string[] {
  return values.map(normalizePermission).filter((perm) => perm.length > 0);
}

/**
 * Reads the permissions catalog from permissions.json
 */
function readPermissionsConfig(): PermissionsConfig {
  const raw = fs.readFileSync(PERMISSIONS_CONFIG_URL, "utf8");
  return JSON.parse(raw) as PermissionsConfig;
}

/**
 * Reads the permission grants from permission-grants.json
 */
function readGrantsConfig(): GrantsConfig {
  const raw = fs.readFileSync(GRANTS_CONFIG_URL, "utf8");
  return JSON.parse(raw) as GrantsConfig;
}

/**
 * Validates that the permission catalog is well-formed
 */
function validatePermissionsConfig(config: PermissionsConfig): void {
  if (!config || typeof config !== "object" || !config.permissions) {
    throw new Error("permissions.json must define a permissions array");
  }

  if (!Array.isArray(config.permissions)) {
    throw new Error("permissions.json permissions must be an array");
  }

  const seen = new Set<string>();
  for (const perm of config.permissions) {
    if (typeof perm !== "string" || !perm.trim()) {
      throw new Error("permissions.json contains invalid permission entry");
    }

    const normalized = normalizePermission(perm);
    if (seen.has(normalized)) {
      throw new Error(`permissions.json contains duplicate permission: ${normalized}`);
    }
    seen.add(normalized);
  }
}

/**
 * Validates that the grants configuration is well-formed
 */
function validateGrantsConfig(config: GrantsConfig, validPermissions: ReadonlySet<Permission>): void {
  if (!config || typeof config !== "object" || !config.grants) {
    throw new Error("permission-grants.json must define a grants object");
  }

  if (typeof config.grants !== "object") {
    throw new Error("permission-grants.json grants must be an object");
  }

  for (const [role, grants] of Object.entries(config.grants)) {
    if (!role.trim()) {
      throw new Error("permission-grants.json contains empty role name");
    }

    if (!Array.isArray(grants)) {
      throw new Error(`permission-grants.json role ${role} must have an array of grants`);
    }

    for (const grant of grants) {
      if (typeof grant !== "string" || !grant.trim()) {
        throw new Error(`permission-grants.json role ${role} contains invalid grant`);
      }

      const normalized = normalizePermission(grant);
      
      // Allow wildcard grants
      if (normalized === "*") {
        continue;
      }

      // Allow resource:* wildcards
      if (normalized.endsWith(":*")) {
        const resource = normalized.slice(0, -2);
        if (!resource) {
          throw new Error(`permission-grants.json role ${role} contains invalid wildcard grant: ${grant}`);
        }
        continue;
      }

      // Validate that non-wildcard grants reference valid permissions
      if (!validPermissions.has(normalized)) {
        throw new Error(`permission-grants.json role ${role} references unknown permission: ${grant}`);
      }
    }
  }
}

/**
 * Builds the permission catalog from configuration files
 */
export function buildPermissionCatalog(): PermissionCatalog {
  const permissionsConfig = readPermissionsConfig();
  validatePermissionsConfig(permissionsConfig);

  const permissions = new Set(normalizePermissionList(permissionsConfig.permissions));

  const grantsConfig = readGrantsConfig();
  validateGrantsConfig(grantsConfig, permissions);

  const grantsByRole = new Map<string, ReadonlySet<PermissionGrant>>();

  for (const [role, grants] of Object.entries(grantsConfig.grants)) {
    const normalizedRole = normalizePermission(role);
    const normalizedGrants = new Set(normalizePermissionList(grants));
    grantsByRole.set(normalizedRole, normalizedGrants);
  }

  return {
    permissions,
    grantsByRole,
  };
}

/**
 * Matches a permission against a grant pattern with wildcard support
 * 
 * Supported patterns:
 * - "*" matches all permissions
 * - "resource:*" matches all actions on a resource (e.g., "bookings:*" matches "bookings:create", "bookings:read")
 * - "resource:action" matches exact permission
 * 
 * @param permission - The permission to check (e.g., "bookings:create")
 * @param grant - The grant pattern (e.g., "*", "bookings:*", "bookings:create")
 * @returns true if the grant matches the permission
 */
export function matchesGrant(permission: string, grant: string): boolean {
  const normalizedPermission = normalizePermission(permission);
  const normalizedGrant = normalizePermission(grant);

  // Full wildcard
  if (normalizedGrant === "*") {
    return true;
  }

  // Exact match
  if (normalizedPermission === normalizedGrant) {
    return true;
  }

  // Resource wildcard (e.g., "bookings:*")
  if (normalizedGrant.endsWith(":*")) {
    const grantResource = normalizedGrant.slice(0, -2);
    const permParts = normalizedPermission.split(":");
    
    if (permParts.length === 2 && permParts[0] === grantResource) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a role has a specific permission based on its grants
 * 
 * @param catalog - The permission catalog
 * @param role - The user role to check
 * @param permission - The permission to verify
 * @returns true if the role has the permission through any of its grants
 */
export function hasPermission(
  catalog: PermissionCatalog,
  role: string,
  permission: string,
): boolean {
  const normalizedRole = normalizePermission(role);
  const normalizedPermission = normalizePermission(permission);

  // Validate that the permission exists in the catalog
  if (!catalog.permissions.has(normalizedPermission)) {
    return false;
  }

  const grants = catalog.grantsByRole.get(normalizedRole);
  if (!grants || grants.size === 0) {
    return false;
  }

  // Check if any grant matches the requested permission
  for (const grant of grants) {
    if (matchesGrant(normalizedPermission, grant)) {
      return true;
    }
  }

  return false;
}

/**
 * Gets all effective permissions for a role by expanding wildcard grants
 * 
 * @param catalog - The permission catalog
 * @param role - The user role
 * @returns Set of all permissions the role has access to
 */
export function getEffectivePermissions(
  catalog: PermissionCatalog,
  role: string,
): ReadonlySet<Permission> {
  const normalizedRole = normalizePermission(role);
  const grants = catalog.grantsByRole.get(normalizedRole);
  
  if (!grants || grants.size === 0) {
    return new Set();
  }

  const effectivePermissions = new Set<Permission>();

  for (const permission of catalog.permissions) {
    for (const grant of grants) {
      if (matchesGrant(permission, grant)) {
        effectivePermissions.add(permission);
        break;
      }
    }
  }

  return effectivePermissions;
}

/**
 * Audits a permission check event
 * 
 * @param role - The role being checked
 * @param permission - The permission being requested
 * @param granted - Whether the permission was granted
 * @param actorIp - IP address of the actor (optional)
 * @param resource - Resource being accessed (optional)
 */
export async function auditPermissionCheck(
  role: string,
  permission: string,
  granted: boolean,
  actorIp?: string,
  resource?: string,
): Promise<void> {
  const action = granted ? "PERMISSION_GRANTED" : "PERMISSION_DENIED";
  const status = granted ? 200 : 403;

  await defaultAuditLogger.log(
    action,
    {
      context: {
        role,
        permission,
        granted,
      },
    },
    {
      actorIp,
      resource,
      status,
    },
  );
}

/**
 * Audits a grant configuration change
 * 
 * @param changeType - Type of change (ADD, REMOVE, MODIFY)
 * @param role - The role being modified
 * @param grants - The grants being changed
 * @param actorId - ID of the admin making the change (optional)
 */
export async function auditGrantChange(
  changeType: "ADD" | "REMOVE" | "MODIFY",
  role: string,
  grants: string[],
  actorId?: string,
): Promise<void> {
  await defaultAuditLogger.log(
    "PERMISSION_GRANT_CHANGE",
    {
      context: {
        changeType,
        role,
        grants,
        actorId,
      },
    },
    {
      status: 200,
    },
  );
}

// Build and export the default permission catalog
export const permissionCatalog = buildPermissionCatalog();
