/**
 * CORS Middleware Module
 * 
 * Implements production-grade CORS validation using the allowlist configuration.
 * Handles preflight requests and validates origins against the allowlist.
 */

import { Request, Response, NextFunction } from "express";
import { isOriginAllowed, CORSConfig } from "../config/cors.js";

/**
 * Creates a CORS middleware that validates origins against an allowlist
 * 
 * Security features:
 * - Validates origin against configured allowlist
 * - Only sets CORS headers if origin is allowed
 * - Properly handles preflight (OPTIONS) requests
 * - Prevents information leakage about valid origins
 * - Supports credentials only if explicitly configured
 * 
 * @param config - CORS configuration with allowlist
 * @returns Express middleware function
 */
export function createCORSMiddleware(config: CORSConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("Origin");

    // Check if origin is allowed
    if (isOriginAllowed(origin, config.allowedOrigins)) {
      // Set CORS headers only for allowed origins
      res.set("Access-Control-Allow-Origin", origin);
      res.set(
        "Access-Control-Allow-Methods",
        config.allowedMethods.join(", "),
      );
      res.set("Access-Control-Allow-Headers", config.allowedHeaders.join(", "));
      res.set("Access-Control-Max-Age", config.maxAge.toString());

      if (config.allowCredentials) {
        res.set("Access-Control-Allow-Credentials", "true");
      }
    }

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      // Return 200 for preflight if origin is allowed
      if (isOriginAllowed(origin, config.allowedOrigins)) {
        return res.sendStatus(200);
      }

      // Return 403 for disallowed origins
      return res.status(403).json({
        success: false,
        error: "CORS policy: Origin not allowed",
      });
    }

    // Continue to next middleware/route
    next();
  };
}
