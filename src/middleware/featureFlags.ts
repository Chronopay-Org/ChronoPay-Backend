import { NextFunction, Request, Response } from "express";
import {
  type FeatureFlagAccessor,
  type FeatureFlagName,
  type RolloutEnvironment,
  getFeatureFlagAccessor,
  isFeatureEnabledForTenant,
  isGuardedRouteRegistered,
  setFeatureFlagsFromEnv,
} from "../flags/index.js";
import { AppError, ServiceUnavailableError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";

/**
 * Accessor extended with scheduled-rollout awareness (#570). `isEnabled`
 * keeps its existing all-or-nothing semantics; `isEnabledForTenant` layers a
 * per-tenant/per-environment rollout percentage on top when one is scheduled.
 */
export interface TenantAwareFeatureFlagAccessor extends FeatureFlagAccessor {
  isEnabledForTenant: (
    flag: FeatureFlagName,
    tenantId: string,
    bucketKey: string,
    environment?: RolloutEnvironment,
  ) => boolean;
}

// Extend Express Request to include flags
declare global {
  namespace Express {
    interface Request {
      flags?: TenantAwareFeatureFlagAccessor;
    }
  }
}

export function featureFlagContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const base = getFeatureFlagAccessor();
  (req as any).flags = {
    ...base,
    isEnabledForTenant: (
      flag: FeatureFlagName,
      tenantId: string,
      bucketKey: string,
      environment?: RolloutEnvironment,
    ): boolean => isFeatureEnabledForTenant(flag, tenantId, bucketKey, environment),
  } satisfies TenantAwareFeatureFlagAccessor;
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
