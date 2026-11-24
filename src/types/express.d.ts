import "express";
import type { ChronoPayRole } from "../middleware/auth.js";
import { AuthenticatedUser } from "../middleware/auth.middleware.js";

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
    auth?: {
      userId: string;
      role: ChronoPayRole;
    };
    rawBody?: Buffer;
    user?: AuthenticatedUser & Record<string, any>;
    /**
     * Feature flag accessor attached by the featureFlags middleware.
     */
    flags?: any;
    /**
     * Legacy auth property
     */
    auth?: any;
    /**
     * Set by `fairQueueBypass` middleware when a valid internal-bypass HMAC
     * signature is presented. Contains the actor ID of the calling service.
     * When set, `createAuthAwareRateLimiter` skips rate limiting for this request.
     */
    internalBypassActor?: string;
    /**
     * Partner API token id attached by apiKeyAuth. Present only on routes
     * protected by that middleware.
     */
    apiKeyId?: string;
  }
}
