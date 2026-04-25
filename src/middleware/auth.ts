import type { NextFunction, Request, Response } from "express";
import { jwtVerify } from "jose";

export type ChronoPayRole = "customer" | "admin" | "professional";

export interface AuthContext {
  userId: string;
  role: ChronoPayRole;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const authHeader =
      (typeof req.header === "function" ? req.header("authorization") : undefined) ??
      (typeof req.headers?.authorization === "string" ? req.headers.authorization : undefined);
    const jwtSecret = process.env.JWT_SECRET;

    if (!authHeader) {
      if (!jwtSecret) {
        return next();
      }

      return res.status(401).json({
        success: false,
        error: "Authorization header is required",
      });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authorization header must use Bearer scheme",
      });
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Bearer token is missing",
      });
    }

    if (!jwtSecret) {
      return res.status(500).json({
        success: false,
        error: "Authentication middleware error",
      });
    }

    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret));
    req.user = payload as Request["user"];
    next();
  } catch {
    return res.status(401).json({
      success: false,
      error: "Invalid or expired token",
    });
  }
}

/**
 * Require a trusted upstream identity header for protected routes.
 * ChronoPay currently assumes authentication is terminated upstream and the
 * backend receives the authenticated principal through request headers.
 */
export function requireAuthenticatedActor(
  allowedRoles: ChronoPayRole[] = ["customer", "admin"],
) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const rawUserId = req.header("x-chronopay-user-id");
    const rawRole = req.header("x-chronopay-role");

    if (!rawUserId || rawUserId.trim().length === 0) {
      return res.status(401).json({
        success: false,
        error: "Authentication required.",
      });
    }

    const role = parseRole(rawRole);
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        error: "Role is not authorized for this action.",
      });
    }

    req.auth = {
      userId: rawUserId.trim(),
      role,
    };

    (req as any).logContext = { userId: rawUserId.trim() };

    next();
  };
}

function parseRole(rawRole: string | undefined): ChronoPayRole {
  if (!rawRole || rawRole.trim().length === 0) {
    return "customer";
  }

  const normalized = rawRole.trim().toLowerCase();
  if (
    normalized === "customer" ||
    normalized === "admin" ||
    normalized === "professional"
  ) {
    return normalized;
  }

  return "professional";
}

export const authenticateToken = requireAuthenticatedActor;
