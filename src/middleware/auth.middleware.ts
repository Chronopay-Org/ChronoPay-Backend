/**
 * Authentication Middleware
 * 
 * Provides JWT-based authentication and authorization middleware.
 * This is a mock implementation that can be replaced with a real JWT verification system.
 */

import { Request, Response, NextFunction } from "express";

/**
 * User roles in the system
 */
export enum UserRole {
  USER = "user",
  ADMIN = "admin",
}

/**
 * Authenticated user structure
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

/**
 * Extend Express Request to include authenticated user
 */
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Mock user database for development/testing
 * In production, this would be replaced with actual JWT verification
 */
const mockUsers: Map<string, AuthenticatedUser> = new Map([
  ["user-1", { id: "user-1", email: "user1@example.com", role: UserRole.USER }],
  ["user-2", { id: "user-2", email: "user2@example.com", role: UserRole.USER }],
  ["admin-1", { id: "admin-1", email: "admin@example.com", role: UserRole.ADMIN }],
]);

/**
 * Mock JWT token validation
 * In production, this would verify the JWT signature and expiration
 */
function validateMockToken(token: string): AuthenticatedUser | null {
  // For testing purposes, accept tokens in format: "Bearer <userId>"
  // In production, this would decode and verify the JWT
  const userId = token.replace("Bearer ", "");
  return mockUsers.get(userId) || null;
}

/**
 * Authentication middleware
 * Verifies the JWT token and attaches the user to the request
 */
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

    const token = authHeader;
    const user = validateMockToken(token);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired token",
        message: "The provided token is invalid or has expired",
      });
    }

    // Attach user to request
    req.user = user;
    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Authentication error",
      message: "An error occurred during authentication",
    });
  }
}

/**
 * Authorization middleware factory
 * Checks if the authenticated user has the required role
 */
export function authorize(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
        message: "User must be authenticated to access this resource",
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: "Insufficient permissions",
        message: `This action requires one of the following roles: ${allowedRoles.join(", ")}`,
      });
    }

    next();
  };
}

/**
 * Check if user is accessing their own resource
 * Prevents horizontal privilege escalation
 */
export function authorizeOwnerOrAdmin(getResourceUserId: (req: Request) => string | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Authentication required",
        message: "User must be authenticated to access this resource",
      });
    }

    // Admins can access any resource
    if (req.user.role === UserRole.ADMIN) {
      return next();
    }

    // Get the user ID associated with the resource
    const resourceUserId = getResourceUserId(req);

    if (!resourceUserId) {
      return res.status(404).json({
        success: false,
        error: "Resource not found",
        message: "The requested resource does not exist",
      });
    }

    // Check if user is accessing their own resource
    if (req.user.id !== resourceUserId) {
      return res.status(403).json({
        success: false,
        error: "Access denied",
        message: "You can only access your own resources",
      });
    }

    next();
  };
}

/**
 * Helper function to add mock users for testing
 */
export function addMockUser(user: AuthenticatedUser): void {
  mockUsers.set(user.id, user);
}

/**
 * Helper function to clear mock users (for testing)
 */
export function clearMockUsers(): void {
  mockUsers.clear();
}

/**
 * Helper function to get mock users (for testing)
 */
export function getMockUsers(): Map<string, AuthenticatedUser> {
  return new Map(mockUsers);
}
