/**
 * Authentication Middleware
 *
 * Provides JWT-based authentication and authorization middleware.
 */

import { Request, Response, NextFunction } from "express";
import { verifyJwt, type VerifiedJwtPayload } from "../utils/jwt.js";
import { configService } from "../config/config.service.js";

export enum UserRole {
  USER = "user",
  ADMIN = "admin",
}

export interface AuthenticatedUser {
  [key: string]: unknown;
  id: string;
  email: string;
  role: UserRole;
}

declare global {
  namespace Express {
    interface Request {
      user?: VerifiedJwtPayload;
    }
  }
}

/**
 * Authentication middleware
 *
 * Reads the `Authorization: Bearer <jwt>` header, verifies the signature and
 * expiry against the active JWT secrets (including rotated-out versions), and
 * attaches the decoded payload to `req.user`.
 *
 * Status codes:
 * - 401 the request carried no usable credentials (missing header, wrong
 *   scheme, empty token, or a token that fails verification)
 * - 500 the service is misconfigured (no signing secret available), which is
 *   a server fault and must not be reported as "unauthenticated"
 */
export function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers?.authorization;

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      error: "Authorization header is required",
    });
  }

  const [scheme, ...rest] = authHeader.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== "bearer") {
    return res.status(401).json({
      success: false,
      error: "Authorization header must use the Bearer scheme",
    });
  }

  const token = rest.join(" ").trim();
  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Bearer token is missing",
    });
  }

  // Without a signing key we cannot validate anything, and reporting 401 here
  // would tell an authenticated caller they are merely unauthorized. Surface
  // the server-side misconfiguration instead.
  if (!hasJwtSecret()) {
    return res.status(500).json({
      success: false,
      error: "Authentication middleware error: JWT signing secret is not configured",
      message: "Authentication middleware error",
    });
  }

  verifyJwt(token)
    .then((decoded) => {
      // `Express.Request["user"]` is declared twice in src/types/express.d.ts
      // (a pre-existing conflict), and the surviving shape requires a string
      // `id` while the JWT payload types it as optional. The payload is the
      // source of truth, so narrow it at the single assignment site rather
      // than widening the global type for every caller.
      req.user = decoded as typeof req.user;
      next();
    })
    .catch(() => {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired token",
      });
    });
}

/**
 * Optional variant of {@link authenticateToken}.
 *
 * Populates `req.user` when a valid bearer token is present, and continues
 * unauthenticated when the request carries no `Authorization` header at all.
 * A header that *is* present but unusable is still a 401 — sending broken
 * credentials is a client error, not an anonymous request.
 *
 * Used on routes that are readable anonymously but whose behaviour narrows
 * once the caller identifies itself.
 */
export function authenticateTokenIfPresent(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.headers?.authorization) {
    return next();
  }
  return authenticateToken(req, res, next);
}

/**
 * True when at least one JWT signing secret is available.
 *
 * The default secrets provider is env-backed, so the environment is checked
 * directly; the config service is consulted as well for deployments that
 * register an explicit provider.
 */
function hasJwtSecret(): boolean {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length > 0) {
    return true;
  }
  return configService.getAllSecretVersions("JWT_SECRET").length > 0;
}

export { authenticateToken as authenticate };

/**
 * Authorization middleware factory
 * Checks if the authenticated user has the required role
 */
export function authorize(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const userRole = req.user.role as UserRole;
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: "Insufficient permissions",
        message: `This action requires one of the following roles: ${allowedRoles.join(", ")}`,
      });
    }

    return next();
  };
}

export function authorizeOwnerOrAdmin(getResourceUserId: (req: Request) => string | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const userRole = req.user.role;
    if (userRole === "admin") {
      return next();
    }

    const resourceUserId = getResourceUserId(req);
    if (!resourceUserId) {
      return res.status(404).json({ success: false, error: "Resource not found" });
    }

    const userId = req.user.sub || req.user.id;
    if (userId !== resourceUserId) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    return next();
  };
}
