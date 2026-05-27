import type { NextFunction, Request, Response } from "express";
import { configService } from "../config/config.service.js";
import { verifyJwt, type VerifiedJwtPayload } from "../utils/jwt.js";

function emitAuthAudit(
  _req: Request,
  _action: string,
  _status: number,
  _meta?: Record<string, unknown>,
): void {
  // Stub — wired to the audit system in production.
}

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

export function requireAuthenticatedActor(allowedRoles: ChronoPayRole[] = ["customer", "admin"]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.auth) {
        const token = readBearerToken(req);
        if (!token) {
          return res.status(401).json({ success: false, error: "Authentication required." });
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
