import { Request, Response, NextFunction } from "express";
import { ContentNegotiationError } from "../errors/AppError.js";

/**
 * Methods that typically carry a request body and require Content-Type validation
 */
const BODY_METHODS = ["POST", "PUT", "PATCH"];

/**
 * Methods that should skip content negotiation checks entirely
 */
const SKIP_METHODS = ["OPTIONS", "HEAD"];

/**
 * Methods that should skip Accept header check (GET, DELETE have no body but should still work)
 */
const SKIP_ACCEPT_CHECK_METHODS = ["GET", "DELETE"];

/**
 * Checks if the Content-Type header indicates JSON
 * Handles charset variants like 'application/json; charset=utf-8'
 */
function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0].trim();
  return mediaType === "application/json";
}

/**
 * Checks if the Accept header accepts JSON
 * Returns true if Accept is missing, includes application/json, or includes wildcard
 */
function acceptsJson(accept: string | undefined): boolean {
  if (!accept) return true; // No Accept header is treated as accepting everything
  return accept.includes("application/json") || accept.includes("*/*");
}

/**
 * Creates content negotiation middleware
 *
 * @param options - Configuration options
 * @param options.excludePaths - Array of path prefixes to exclude from checks (e.g., webhook routes)
 * @returns Express middleware function
 */
export function createContentNegotiationMiddleware(options?: {
  excludePaths?: string[];
}) {
  const excludePaths = options?.excludePaths || [];

  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method;
    const path = req.originalUrl || req.url;

    // Skip OPTIONS requests (CORS preflight)
    if (SKIP_METHODS.includes(method)) {
      return next();
    }

    // Skip excluded paths (e.g., webhook endpoints)
    if (excludePaths.some((excludedPath) => path.startsWith(excludedPath))) {
      return next();
    }

    // Only check Content-Type for methods that typically have a body
    if (BODY_METHODS.includes(method)) {
      const contentType = req.headers["content-type"];
      
      if (!isJsonContentType(contentType)) {
        return next(
          new ContentNegotiationError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "Content-Type must be application/json",
          ),
        );
      }
    }

    // Check Accept header (skip for methods that don't need it)
    if (!SKIP_ACCEPT_CHECK_METHODS.includes(method)) {
      const accept = req.headers.accept;

      if (!acceptsJson(accept)) {
        return next(
          new ContentNegotiationError(
            406,
            "NOT_ACCEPTABLE",
            "Accept header must include application/json",
          ),
        );
      }
    }

    next();
  };
}
