import { createHash } from "node:crypto";
import fs from "node:fs";
import { Request, Response, NextFunction } from "express";
import { ConfigurationError, ForbiddenError, UnauthorizedError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { partnerTierService } from "../services/partnerTierService.js";
import { constantTimeEquals } from "../utils/constantTimeEquals.js";

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

function validatePartnerTiersConfig(config: unknown): PartnerTiersConfig {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Partner tiers config must be a JSON object");
  }

  const tiers = (config as Record<string, unknown>).tiers;
  if (tiers === null || typeof tiers !== "object" || Array.isArray(tiers)) {
    throw new Error("Partner tiers config must contain a tiers object");
  }

  const validatedTiers: Record<string, string[]> = {};
  for (const [tier, endpoints] of Object.entries(tiers)) {
    if (!tier || !Array.isArray(endpoints) || !endpoints.every(endpoint => typeof endpoint === "string")) {
      throw new Error(`Partner tier "${tier}" must have an array of endpoint strings`);
    }
    validatedTiers[tier] = endpoints;
  }

  return { tiers: validatedTiers };
}

function loadPartnerTiersConfig(): PartnerTiersConfig {
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(PARTNER_TIERS_CONFIG_URL, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Unable to load partner tiers config", { cause: error });
  }
  return validatePartnerTiersConfig(parsed);
}

let partnerTiersConfig = loadPartnerTiersConfig();

export function readPartnerTiersConfig(): PartnerTiersConfig {
  return partnerTiersConfig;
}

export function reloadPartnerTiersConfig(): PartnerTiersConfig {
  partnerTiersConfig = loadPartnerTiersConfig();
  return partnerTiersConfig;
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
      if (process.env.NODE_ENV === "production") {
        return sendErrorResponse(
          res,
          new ConfigurationError("API key authorization is not configured"),
          req,
        );
      }
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

    if (!constantTimeEquals(provided, expectedApiKey)) {
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
      const path = `${req.baseUrl}${req.path}`;

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
