import { Request, Response, NextFunction } from "express";
import { defaultAuditLogger } from "../services/auditLogger.js";

const ROLE_HEADER = "x-user-role";
const VALID_ROLES = ["admin", "professional", "customer"] as const;

type UserRole = (typeof VALID_ROLES)[number];

function normalizeRole(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase();
}

function isValidRole(role: string): role is UserRole {
  return VALID_ROLES.includes(role as UserRole);
}

function emitRbacAudit(
  req: Request,
  code: string,
  status: number,
  extra?: Record<string, unknown>,
): void {
  // Never log raw header values — only stable codes and request metadata.
  defaultAuditLogger.log({
    action: code,
    actorIp: req.ip || req.socket?.remoteAddress,
    resource: req.originalUrl,
    status,
    metadata: { method: req.method, ...extra },
  });
}

export function requireRole(allowedRoles: UserRole[]) {
  const allowedRoleSet = new Set<UserRole>(allowedRoles);

  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedRole = normalizeRole(req.header(ROLE_HEADER));

      if (!parsedRole) {
        emitRbacAudit(req, "RBAC_MISSING", 401);
        return res.status(401).json({
          success: false,
          error: `Missing required authentication header: ${ROLE_HEADER}`,
        });
      }

      if (!isValidRole(parsedRole)) {
        // parsedRole is a normalized string — safe to log as it is not a raw header value.
        emitRbacAudit(req, "RBAC_INVALID_ROLE", 400, { role: parsedRole });
        return res.status(400).json({
          success: false,
          error: "Invalid user role",
        });
      }

      if (!allowedRoleSet.has(parsedRole)) {
        emitRbacAudit(req, "RBAC_FORBIDDEN", 403, { role: parsedRole });
        return res.status(403).json({
          success: false,
          error: "Insufficient permissions",
        });
      }

      return next();
    } catch {
      return res.status(500).json({
        success: false,
        error: "Authorization middleware error",
      });
    }
  };
}

export const roles = {
  admin: "admin" as UserRole,
  professional: "professional" as UserRole,
  customer: "customer" as UserRole,
};
