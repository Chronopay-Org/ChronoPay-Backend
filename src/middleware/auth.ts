import type { NextFunction, Request, Response } from "express";


import { defaultAuditLogger } from "../services/auditLogger.js";
import { verifyJwt, type VerifiedJwtPayload } from "../utils/jwt.js";
import { configService } from "../config/config.service.js";

export type ChronoPayRole = "customer" | "admin" | "professional";

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

function parseRole(value: unknown): ChronoPayRole {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (role === "admin" || role === "professional" || role === "customer") {
    return role;
  }

  return "customer";
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
        role: parseRole(payload.role),
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
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.headers["x-chronopay-user-id"] as string | undefined;
      const roleHeader = req.headers["x-chronopay-role"] as string | undefined;

      if (!userId) {
        return res.status(401).json({ success: false, error: "Authentication required." });
      }

      req.auth = {
        userId,
        role: parseRole(roleHeader),
        claims: {} as VerifiedJwtPayload,
      };

      if (!req.auth.userId) {
        return res.status(401).json({ success: false, error: "Authentication required." });
      }

      if (!allowedRoles.includes(req.auth.role)) {
        return res.status(403).json({ success: false, error: "Role is not authorized for this action." });
      }

      next();
    } catch {
      return res.status(401).json({ success: false, error: "Invalid or expired token" });
    }
  };
}

function __emitAuthAudit(
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
