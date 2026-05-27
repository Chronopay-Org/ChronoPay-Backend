import "express";
import type { FeatureFlagAccessor } from "../flags/types.js";

declare module "express-serve-static-core" {
  interface Request {
    /**
     * Decoded JWT payload attached by JWT authentication middleware.
     * Present only on routes protected by authenticateToken or authenticate.
     */
    user?: {
      id: string;
      sub?: string;
      email?: string;
      role?: string;
      iat?: number;
      exp?: number;
      [key: string]: unknown;
    };
    /**
     * Authentication context set by JWT-based auth middleware.
     * Contains userId, role, and verified claims from the token.
     */
    auth?: {
      userId: string;
      role: string;
      claims?: Record<string, unknown>;
    };
    /**
     * API key identifier (SHA-256 hash) set by requireApiKey middleware.
     */
    apiKeyId?: string;
    flags?: FeatureFlagAccessor;
  }
}
