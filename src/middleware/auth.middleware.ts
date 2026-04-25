/**
 * Authentication Middleware
 *
 * Provides JWT-based authentication and authorization middleware.
 */

import { Request, Response, NextFunction } from "express";
import { verifyJwt, VerifiedJwtPayload } from "../utils/jwt.js";

export enum UserRole {
  USER = "user",
  ADMIN = "admin",
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  [key: string]: unknown;
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
 * Verifies the JWT token and attaches the decoded payload to the request
 */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const [bearer, token] = authHeader.split(" ");
  if (bearer !== "Bearer" || !token) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    const decoded = verifyJwt(token);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
}

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

export function authorizeOwnerOrAdmin(
  getResourceUserId: (req: Request) => string | null,
) {
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
