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
        return sendErrorResponse(
          res,
          new UnauthorizedError(
            `Missing required authentication header: ${ROLE_HEADER}`,
            ERROR_CODES.AUTHENTICATION_REQUIRED.code,
          ),
          req,
        );
      }

      if (!isValidRole(parsedRole)) {
        // parsedRole is a normalized string — safe to log as it is not a raw header value.
        emitRbacAudit(req, "RBAC_INVALID_ROLE", 400, { role: parsedRole });
        return sendErrorResponse(
          res,
          new BadRequestError("Invalid user role"),
          req,
        );
      }

      if (!allowedRoleSet.has(parsedRole)) {
        emitRbacAudit(req, "RBAC_FORBIDDEN", 403, { role: parsedRole });
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

export const roles = {
  admin: "admin" as UserRole,
  professional: "professional" as UserRole,
  customer: "customer" as UserRole,
};
