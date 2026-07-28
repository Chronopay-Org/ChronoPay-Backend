import { createHash } from "node:crypto";
import fs from "node:fs";
import { Request, Response, NextFunction } from "express";
import { ForbiddenError, UnauthorizedError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { partnerTierService } from "../services/partnerTierService.js";

const API_KEY_HEADER = "x-api-key";
const API_KEY_ID_PREFIX = "apiKey_";
const API_KEY_HASH_ALGORITHM = "sha256";
const PARTNER_TIERS_CONFIG_URL = new URL("../config/partner-tiers.json", import.meta.url);

declare module "express" {
  interface Request {
    apiKeyId?: string;
    partnerTier?: string;
  }
}

export interface PartnerTiersConfig {
  tiers: Record<string, string[]>;
}

export function readPartnerTiersConfig(): PartnerTiersConfig {
  try {
    const raw = fs.readFileSync(PARTNER_TIERS_CONFIG_URL, "utf8");
    return JSON.parse(raw) as PartnerTiersConfig;
  } catch {
    return { tiers: {} };
  }
}


export function deriveApiKeyId(apiKey: string): string {
  const hash = createHash(API_KEY_HASH_ALGORITHM)
    .update(apiKey, "utf8")
    .digest("hex");

  return `${API_KEY_ID_PREFIX}${hash}`;
}

export function matchEndpoint(allowedEndpoint: string, method: string, path: string): boolean {
  if (allowedEndpoint === "*") return true;
  
  const [allowedMethod, allowedPath] = allowedEndpoint.split(" ", 2);
  
  if (allowedMethod !== method && allowedMethod !== "*") return false;
  
  if (allowedPath.endsWith("/*")) {
    const prefix = allowedPath.slice(0, -2);
    return path === prefix || path.startsWith(prefix + "/");
  }
  
  return path === allowedPath;
}

export function isEndpointAllowed(tier: string, method: string, path: string, config: PartnerTiersConfig): boolean {
  const allowedEndpoints = config.tiers[tier] || [];
  return allowedEndpoints.some(endpoint => matchEndpoint(endpoint, method, path));
}

export function requireApiKey(expectedApiKey?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!expectedApiKey) {
      return next();
    }

    const provided = req.header(API_KEY_HEADER);

    if (!provided) {
      return sendErrorResponse(
        res,
        new UnauthorizedError("Missing API key", ERROR_CODES.INVALID_API_KEY.code),
        req,
      );
    }

    if (provided !== expectedApiKey) {
      return sendErrorResponse(
        res,
        new ForbiddenError("Invalid API key", ERROR_CODES.INVALID_API_KEY.code),
        req,
      );
    }

    const apiKeyId = deriveApiKeyId(provided);
    req.apiKeyId = apiKeyId;

    try {
      const tier = await partnerTierService.fetchPartnerTier(apiKeyId);
      req.partnerTier = tier;

      const config = readPartnerTiersConfig();
      const method = req.method;
      const path = req.originalUrl || req.path;

      if (!isEndpointAllowed(tier, method, path, config)) {
        defaultAuditLogger.log({
          action: "PARTNER_TIER_DENIED",
          actorIp: req.ip || req.socket?.remoteAddress,
          resource: path,
          status: 403,
          metadata: { method, tier, apiKeyId }
        }).catch(() => {});
        
        return sendErrorResponse(
          res,
          new ForbiddenError("Endpoint not allowed for partner tier", ERROR_CODES.INSUFFICIENT_PERMISSIONS?.code || "INSUFFICIENT_PERMISSIONS"),
          req,
        );
      }

      next();
    } catch (err) {
      return next(err);
    }
  };
}
