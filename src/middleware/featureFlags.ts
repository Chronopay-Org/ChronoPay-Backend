import { NextFunction, Request, Response } from "express";
import {
  getFeatureFlagAccessor,
  isGuardedRouteRegistered,
  setFeatureFlagsFromEnv,
} from "../flags/index.js";
import type { FeatureFlagName } from "../flags/index.js";

// Extend Express Request to include flags
declare global {
  namespace Express {
    interface Request {
      flags?: ReturnType<typeof getFeatureFlagAccessor>;
    }
  }
}

export function featureFlagContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  (req as any).flags = getFeatureFlagAccessor();
  next();
}

export function assertFeatureFlagGuardRegistration(
  flag: FeatureFlagName,
  method: string,
  path: string,
): void {
  if (!isGuardedRouteRegistered(flag, method, path)) {
    throw new Error(
      `Missing feature-flag registry entry for ${flag} guard on ${method.toUpperCase()} ${path}`,
    );
  }
}

export function requireFeatureFlag(flag: FeatureFlagName) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.flags!.isEnabled(flag)) {
        return res.status(503).json({
          success: false,
          code: "FEATURE_DISABLED",
          error: `Feature ${flag} is currently disabled`,
        });
      }

      next();
    } catch {
      return res.status(500).json({
        success: false,
        code: "FEATURE_FLAG_EVALUATION_ERROR",
        error: "Feature flag evaluation failed",
      });
    }
  };
}

export function initializeFeatureFlagsFromEnv(): void {
  setFeatureFlagsFromEnv(process.env);
}
