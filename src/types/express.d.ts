import "express";

declare module "express-serve-static-core" {
  interface Request {
    /**
     * Decoded JWT payload attached by the authenticateToken middleware.
     * Present only on routes protected by authenticateToken.
     */
    user?: {
      sub?: string;
      email?: string;
      iat?: number;
      exp?: number;
      [key: string]: unknown;
    };
  }
}
