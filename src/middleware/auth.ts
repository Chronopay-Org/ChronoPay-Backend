import type { NextFunction, Request, Response } from "express";


import { defaultAuditLogger } from "../services/auditLogger.js";
import { verifyJwt, type VerifiedJwtPayload } from "../utils/jwt.js";
import { configService } from "../config/config.service.js";
import {
  auditRoleDenied,
  isKnownRole,
  roleSatisfies,
  type UserRole,
} from "./rbac.js";

export type ChronoPayRole = UserRole;

export interface AuthContext {
  userId: string;
  role: ChronoPayRole;
  claims: VerifiedJwtPayload;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      user?: VerifiedJwtPayload;
    }
  }
}

function parseRole(value: unknown): ChronoPayRole | null {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (isKnownRole(role)) {
    return role;
  }

  return null;
}

function parseJwtRole(value: unknown): ChronoPayRole {
  return parseRole(value) ?? "customer";
}

function getUserId(claims: VerifiedJwtPayload): string {
  const candidate = claims.sub ?? claims.id;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : "";
}

function readBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function requireAuth(expectedIssuer?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = readBearerToken(req);
      if (!token) {
        return res.status(401).json({ success: false, error: "Missing Authorization header" });
      }

      const payload = await verifyJwt(token, { issuer: expectedIssuer ?? configService.jwtIssuer ?? undefined });
      // @ts-expect-error - Auto-fixed by script
      req.user = payload;
      req.auth = {
        userId: getUserId(payload),
        role: parseJwtRole(payload.role),
        claims: payload,
      };

      next();
    } catch {
      return res.status(401).json({ success: false, error: "Invalid or expired token" });
    }
  };
}

// Named export for the header-based auth used by booking-intents
export { requireAuthenticatedActor as authenticateToken };

export function requireAuthenticatedActor(allowedRoles: ChronoPayRole[]) {
  const requiredRoles = allowedRoles.map((role) => role.trim().toLowerCase());
  for (const requiredRole of requiredRoles) {
    if (!isKnownRole(requiredRole)) {
      throw new Error(`requireAuthenticatedActor declares unknown role ${requiredRole}`);
    }
  }

  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.headers["x-chronopay-user-id"] as string | undefined;
      const roleHeader = req.headers["x-chronopay-role"] as string | undefined;

      if (!userId) {
        return res.status(401).json({ success: false, error: "Authentication required." });
      }

      if (!userId.trim()) {
        return res.status(401).json({ success: false, error: "Authentication required." });
      }

      const role = parseRole(roleHeader);
      if (!role) {
        auditRoleDenied(req, roleHeader ? "RBAC_INVALID_ROLE" : "RBAC_MISSING", roleHeader ? 400 : 401);
        return res
          .status(roleHeader ? 400 : 401)
          .json({ success: false, error: "Role is not authorized for this action." });
      }

      req.auth = {
        userId: userId.trim(),
        role,
        claims: {} as VerifiedJwtPayload,
      };

      if (!requiredRoles.some((requiredRole) => roleSatisfies(req.auth!.role, requiredRole))) {
        auditRoleDenied(req, "RBAC_FORBIDDEN", 403, {
          role: req.auth.role,
          requiredRoles,
        });
        return res.status(403).json({ success: false, error: "Role is not authorized for this action." });
      }

      next();
    } catch {
      return res.status(401).json({ success: false, error: "Invalid or expired token" });
    }
  };
}

// eslint-disable-next-line unused-imports/no-unused-vars
function emitAuthAudit(
  req: Request,
  action: string,
  status: number,
  extra?: Record<string, unknown>,
): void {
  defaultAuditLogger.log(
    `auth.${action}`,
    {
      method: req.method,
      ...extra,
    },
    {
      actorIp: req.ip || req.socket?.remoteAddress,
      resource: req.originalUrl,
      status,
    },
  ).catch(() => {}); // Fire and forget
}

// Removed duplicate export of authenticateToken
