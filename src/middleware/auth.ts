import type { NextFunction, Request, Response } from "express";
import { jwtVerify } from "jose";
import {
  ForbiddenError,
  InternalServerError,
  UnauthorizedError,
} from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";
import { defaultAuditLogger } from "../services/auditLogger.js";

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

function emitAuthAudit(
  req: Request,
  code: string,
  status: number,
  extra?: Record<string, unknown>,
): void {
  defaultAuditLogger.log({
    action: code,
    actorIp: req.ip || req.socket?.remoteAddress,
    resource: req.originalUrl,
    status,
    metadata: { method: req.method, ...extra },
  }).catch(() => {});
}

function parseRole(rawRole: string | undefined): ChronoPayRole {
  if (!rawRole || rawRole.trim().length === 0) {
    return "customer";
  }

        const payload = await verifyJwt(token, { issuer: configService.jwtIssuer ?? undefined });
        req.user = payload;
        req.auth = {
          userId: getUserId(payload),
          role: parseRole(payload.role),
          claims: payload,
        };
      }

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
