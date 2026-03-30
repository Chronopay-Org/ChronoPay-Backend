import { NextFunction, Request, Response } from "express";
import { getFeatureFlagAccessor, setFeatureFlagsFromEnv } from "../flags/index.js";
import type { FeatureFlagName } from "../flags/index.js";

export function featureFlagContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  req.flags = getFeatureFlagAccessor();
  next();
}

export function requireFeatureFlag(flag: FeatureFlagName) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.flags.isEnabled(flag)) {
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
