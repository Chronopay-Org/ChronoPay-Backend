import type { NextFunction, Request, Response } from "express";


import { defaultAuditLogger } from "../services/auditLogger.js";
import type { VerifiedJwtPayload } from "../utils/jwt.js";
import { configService } from "../config/config.service.js";
import {
  getUserId,
  readBearerToken,
  verifyRequestJwt,
  MissingBearerTokenError,
} from "./jwtIdentity.js";
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

export { getUserId, readBearerToken };

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      user?: VerifiedJwtPayload;
    }
  }
}

export function parseRole(value: unknown): ChronoPayRole | null {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (isKnownRole(role)) {
    return role;
  }

  return null;
}

export function parseJwtRole(value: unknown): ChronoPayRole {
  return parseRole(value) ?? "customer";
}

export function requireAuth(expectedIssuer?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = readBearerToken(req);
      if (!token) {
        return res.status(401).json({ success: false, error: "Missing Authorization header" });
      }

      const payload = await verifyRequestJwt(req, expectedIssuer);
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

// Named export retained for booking-intents JWT authentication.
export { requireAuthenticatedActor as authenticateToken };

export function requireAuthenticatedActor(allowedRoles: ChronoPayRole[]) {
  const requiredRoles = allowedRoles.map((role) => role.trim().toLowerCase());
  for (const requiredRole of requiredRoles) {
    if (!isKnownRole(requiredRole)) {
      throw new Error(`requireAuthenticatedActor declares unknown role ${requiredRole}`);
    }
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const claims = await verifyRequestJwt(req);
      const userId = getUserId(claims);
      if (!userId) {
        return res.status(401).json({ success: false, error: "Authentication required." });
      }

      const role = parseJwtRole(claims.role);

      req.auth = {
        userId,
        role,
        claims,
      };

      if (!requiredRoles.some((requiredRole) => roleSatisfies(req.auth!.role, requiredRole))) {
        auditRoleDenied(req, "RBAC_FORBIDDEN", 403, {
          role: req.auth.role,
          requiredRoles,
        });
        return res.status(403).json({ success: false, error: "Role is not authorized for this action." });
      }

      next();
    } catch (error) {
      const message =
        error instanceof MissingBearerTokenError
          ? "Authentication required."
          : "Invalid or expired token";
      return res.status(401).json({ success: false, error: message });
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
