import fs from "fs";
import { Request, Response, NextFunction } from "express";
import { defaultAuditLogger } from "../services/auditLogger.js";
import {
  BadRequestError,
  ForbiddenError,
  InternalServerError,
  UnauthorizedError,
} from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";

const ROLE_HEADER = "x-user-role";
const ROLES_CONFIG_URL = new URL("../config/roles.json", import.meta.url);

export type UserRole = string;

interface RolesConfig {
  roles: Record<string, string[]>;
}

export interface RoleHierarchy {
  roles: ReadonlySet<UserRole>;
  effectiveRolesByRole: ReadonlyMap<UserRole, ReadonlySet<UserRole>>;
}

function normalizeRole(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase();
}

function normalizeRoleList(values: readonly string[]): string[] {
  return values.map(normalizeRole).filter((role) => role.length > 0);
}

function readRolesConfig(): RolesConfig {
  const raw = fs.readFileSync(ROLES_CONFIG_URL, "utf8");
  return JSON.parse(raw) as RolesConfig;
}

export function buildRoleHierarchy(config: RolesConfig): RoleHierarchy {
  if (!config || typeof config !== "object" || !config.roles || typeof config.roles !== "object") {
    throw new Error("roles.json must define a roles object");
  }

  const directImplications = new Map<UserRole, UserRole[]>();

  for (const [rawRole, rawImplications] of Object.entries(config.roles)) {
    const role = normalizeRole(rawRole);
    if (!role) {
      throw new Error("roles.json contains an empty role name");
    }

    if (!Array.isArray(rawImplications)) {
      throw new Error(`roles.json role ${role} must list implied roles`);
    }

    directImplications.set(role, normalizeRoleList(rawImplications));
  }

  for (const [role, implications] of directImplications) {
    for (const impliedRole of implications) {
      if (!directImplications.has(impliedRole)) {
        throw new Error(`roles.json role ${role} implies unknown role ${impliedRole}`);
      }
    }
  }

  const visiting = new Set<UserRole>();
  const visited = new Set<UserRole>();
  const effectiveRolesByRole = new Map<UserRole, ReadonlySet<UserRole>>();

  function resolve(role: UserRole, path: UserRole[]): Set<UserRole> {
    if (effectiveRolesByRole.has(role)) {
      return new Set(effectiveRolesByRole.get(role)!);
    }

    if (visiting.has(role)) {
      throw new Error(`roles.json contains a cyclic role definition: ${[...path, role].join(" -> ")}`);
    }

    visiting.add(role);
    const effective = new Set<UserRole>([role]);

    for (const impliedRole of directImplications.get(role) ?? []) {
      for (const resolvedRole of resolve(impliedRole, [...path, role])) {
        effective.add(resolvedRole);
      }
    }

    visiting.delete(role);
    visited.add(role);
    effectiveRolesByRole.set(role, effective);
    return effective;
  }

  for (const role of directImplications.keys()) {
    if (!visited.has(role)) {
      resolve(role, []);
    }
  }

  return {
    roles: new Set(directImplications.keys()),
    effectiveRolesByRole,
  };
}

const roleHierarchy = buildRoleHierarchy(readRolesConfig());

export function isKnownRole(role: string): boolean {
  return roleHierarchy.roles.has(role);
}

export function getEffectiveRoles(role: string): ReadonlySet<UserRole> {
  return roleHierarchy.effectiveRolesByRole.get(role) ?? new Set<UserRole>();
}

export function roleSatisfies(role: string, requiredRole: string): boolean {
  return getEffectiveRoles(role).has(requiredRole);
}

function emitRbacAudit(
  req: Request,
  code: string,
  status: number,
  extra?: Record<string, unknown>,
): void {
  // Never log raw header values. Roles are normalized and accepted only after
  // they are found in roles.json, which keeps audit metadata bounded.
  defaultAuditLogger.log({
    action: code,
    actorIp: req.ip || req.socket?.remoteAddress,
    resource: req.originalUrl,
    status,
    metadata: { method: req.method, ...extra },
  }).catch(() => {});
}

export function auditRoleDenied(
  req: Request,
  code: "RBAC_MISSING" | "RBAC_INVALID_ROLE" | "RBAC_FORBIDDEN",
  status: number,
  extra?: Record<string, unknown>,
): void {
  emitRbacAudit(req, code, status, extra);
}

export function requireRole(requiredRoles: UserRole | UserRole[]) {
  const requiredRoleSet = new Set(normalizeRoleList(Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles]));

  if (requiredRoleSet.size === 0) {
    throw new Error("requireRole must declare at least one required role");
  }

  for (const requiredRole of requiredRoleSet) {
    if (!isKnownRole(requiredRole)) {
      throw new Error(`requireRole declares unknown role ${requiredRole}`);
    }
  }

  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedRole = normalizeRole(req.header(ROLE_HEADER));

      if (!parsedRole) {
        emitRbacAudit(req, "RBAC_MISSING", 401);
        return sendErrorResponse(
          res,
          new UnauthorizedError(
            `Missing required authentication header: ${ROLE_HEADER}`,
            ERROR_CODES.AUTHENTICATION_REQUIRED.code,
          ),
          req,
        );
      }

      if (!isKnownRole(parsedRole)) {
        emitRbacAudit(req, "RBAC_INVALID_ROLE", 400);
        return sendErrorResponse(
          res,
          new BadRequestError("Invalid user role"),
          req,
        );
      }

      const authorized = [...requiredRoleSet].some((requiredRole) =>
        roleSatisfies(parsedRole, requiredRole),
      );

      if (!authorized) {
        emitRbacAudit(req, "RBAC_FORBIDDEN", 403, {
          role: parsedRole,
          requiredRoles: [...requiredRoleSet],
        });
        return sendErrorResponse(
          res,
          new ForbiddenError(
            "Insufficient permissions",
            ERROR_CODES.INSUFFICIENT_PERMISSIONS.code,
          ),
          req,
        );
      }

      return next();
    } catch {
      return sendErrorResponse(
        res,
        new InternalServerError("Authorization middleware error"),
        req,
      );
    }
  };
}

export const roles = Object.fromEntries(
  [...roleHierarchy.roles].map((role) => [role, role]),
) as Record<UserRole, UserRole>;
