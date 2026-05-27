import { NextFunction, Request, Response } from "express";
import {
  getFeatureFlagAccessor,
  isGuardedRouteRegistered,
  setFeatureFlagsFromEnv,
} from "../flags/index.js";
import type { FeatureFlagName } from "../flags/index.js";
import { AppError, ServiceUnavailableError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";

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
        return sendErrorResponse(
          res,
          new ServiceUnavailableError(
            `Feature ${flag} is currently disabled`,
            ERROR_CODES.FEATURE_DISABLED.code,
          ),
          req,
        );
      }

      next();
    } catch {
      return sendErrorResponse(
        res,
        new AppError(
          "Feature flag evaluation failed",
          ERROR_CODES.FEATURE_FLAG_EVALUATION_ERROR.status,
          ERROR_CODES.FEATURE_FLAG_EVALUATION_ERROR.code,
          true,
        ),
        req,
      );
    }
  };
}

export function initializeFeatureFlagsFromEnv(): void {
  setFeatureFlagsFromEnv(process.env);
}
