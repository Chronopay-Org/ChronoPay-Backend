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
    flags?: FeatureFlagAccessor;
  }
}
