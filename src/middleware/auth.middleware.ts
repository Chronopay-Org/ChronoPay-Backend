/**
 * Authentication Middleware
 *
 * Provides JWT-based authentication and authorization middleware.
 * This is a mock implementation that can be replaced with a real JWT verification system.
 */

import { Request, Response, NextFunction } from "express";

export enum UserRole {
  USER = "user",
  ADMIN = "admin",
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const mockUsers: Map<string, AuthenticatedUser> = new Map([
  ["user-1", { id: "user-1", email: "user1@example.com", role: UserRole.USER }],
  ["user-2", { id: "user-2", email: "user2@example.com", role: UserRole.USER }],
  ["admin-1", { id: "admin-1", email: "admin@example.com", role: UserRole.ADMIN }],
]);

function validateMockToken(token: string): AuthenticatedUser | null {
  const userId = token.replace("Bearer ", "");
  return mockUsers.get(userId) || null;
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
        message: "No authorization header provided",
      });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Invalid authentication format",
        message: "Authorization header must be in format: Bearer <token>",
      });
    }

    const user = validateMockToken(authHeader);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired token",
        message: "The provided token is invalid or has expired",
      });
    }

    (req as any).user = user;
    return next();
  } catch {
    return res.status(500).json({
      success: false,
      error: "Authentication error",
      message: "An error occurred during authentication",
    });
  }
}

export function authorize(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as AuthenticatedUser | undefined;

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
        message: "User must be authenticated to access this resource",
      });
    }

    if (!allowedRoles.includes(user.role)) {
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
    const user = req.user as AuthenticatedUser | undefined;

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
        message: "User must be authenticated to access this resource",
      });
    }

    if (user.role === UserRole.ADMIN) {
      return next();
    }

    const resourceUserId = getResourceUserId(req);

    if (!resourceUserId) {
      return res.status(404).json({
        success: false,
        error: "Resource not found",
        message: "The requested resource does not exist",
      });
    }

    if (user.id !== resourceUserId) {
      return res.status(403).json({
        success: false,
        error: "Access denied",
        message: "You can only access your own resources",
      });
    }

    return next();
  };
}

export function addMockUser(user: AuthenticatedUser): void {
  mockUsers.set(user.id, user);
}

export function clearMockUsers(): void {
  mockUsers.clear();
}

export function getMockUsers(): Map<string, AuthenticatedUser> {
  return new Map(mockUsers);
}