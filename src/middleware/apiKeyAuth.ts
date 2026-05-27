import { createHash } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { ForbiddenError, UnauthorizedError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { sendErrorResponse } from "../errors/sendError.js";

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

    req.apiKeyId = deriveApiKeyId(provided);
    next();
  };
}
