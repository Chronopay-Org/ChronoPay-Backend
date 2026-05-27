import "express";
import { AuthenticatedUser } from "../middleware/auth.middleware.js";

declare module "express-serve-static-core" {
  interface Request {
    /**
     * Decoded JWT payload attached by the authenticateToken middleware.
     * Present only on routes protected by authenticateToken.
     */
    user?: AuthenticatedUser & Record<string, any>;
    /**
     * Feature flag accessor attached by the featureFlags middleware.
     */
    flags?: any;
    /**
     * Legacy auth property
     */
    auth?: any;
  }
}
