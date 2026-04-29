import "express";
import type { FeatureFlagAccessor } from "../flags/types.js";

declare module "express-serve-static-core" {
  interface Request {
    /**
     * Decoded JWT payload attached by the authenticateToken middleware.
     * Present only on routes protected by authenticateToken.
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
     * Authentication context set by requireAuthenticatedActor middleware.
     * Contains userId and role from validated headers.
     */
    auth?: {
      userId: string;
      role: string;
    };
    /**
     * API key identifier (SHA-256 hash) set by requireApiKey middleware.
     */
    apiKeyId?: string;
    flags?: FeatureFlagAccessor;
  }
}
