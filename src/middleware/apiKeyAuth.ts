import { createHash } from "node:crypto";
import { Request, Response, NextFunction } from "express";

const API_KEY_HEADER = "x-api-key";
const API_KEY_ID_PREFIX = "apiKey_";
const API_KEY_HASH_ALGORITHM = "sha256";

declare module "express" {
  interface Request {
    apiKeyId?: string;
  }
}

export function deriveApiKeyId(apiKey: string): string {
  const hash = createHash(API_KEY_HASH_ALGORITHM)
    .update(apiKey, "utf8")
    .digest("hex");

  return `${API_KEY_ID_PREFIX}${hash}`;
}

export function requireApiKey(expectedApiKey?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expectedApiKey) {
      return next();
    }

    const provided = req.header(API_KEY_HEADER);

    if (!provided) {
      return res.status(401).json({
        success: false,
        error: "Missing API key",
      });
    }

    if (provided !== expectedApiKey) {
      return res.status(403).json({
        success: false,
        error: "Invalid API key",
      });
    }

    req.apiKeyId = deriveApiKeyId(provided);
    next();
  };
}
