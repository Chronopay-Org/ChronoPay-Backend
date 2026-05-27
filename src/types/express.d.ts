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
     * Raw request body buffer captured for signature verification.
     */
    rawBody?: Buffer;
  }
}
