import { Request, Response, NextFunction } from "express";

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

export function requireRole(allowedRoles: UserRole[]) {
  const allowedRoleSet = new Set<UserRole>(allowedRoles);

  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedRole = normalizeRole(req.header(ROLE_HEADER));

      if (!parsedRole) {
        return res.status(401).json({
          success: false,
          error: `Missing required authentication header: ${ROLE_HEADER}`,
        });
      }

      if (!isValidRole(parsedRole)) {
        return res.status(400).json({
          success: false,
          error: "Invalid user role",
        });
      }

      if (!allowedRoleSet.has(parsedRole)) {
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
