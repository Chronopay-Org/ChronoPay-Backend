import type { NextFunction, Request, Response } from "express";

export type ChronoPayRole = "customer" | "admin" | "professional";

export interface AuthContext {
  userId: string;
  role: ChronoPayRole;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
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

    next();
  };
}

function parseRole(rawRole: string | undefined): ChronoPayRole {
  if (!rawRole || rawRole.trim().length === 0) {
    return "customer";
  }

  const normalized = rawRole.trim().toLowerCase();
  if (normalized === "customer" || normalized === "admin" || normalized === "professional") {
    return normalized;
  }

  return "professional";
}
