import { pinoHttp, Options as PinoHttpOptions } from "pino-http";
import { Request, Response, NextFunction } from "express";
import { logger, LogLevel } from "../utils/logger.js";
import { IncomingMessage, ServerResponse } from "http";
import type { LevelWithSilent } from "pino";

/**
 * Extended Express request interface to include timing and custom properties
 */
declare module "express" {
  interface Request {
    startTime?: number;
  }
}

/**
 * Custom log level derivation based on response status codes
 * - 5xx errors: ERROR level (server-side failures)
 * - 4xx errors: WARN level (client-side errors)
 * - All others: INFO level (successful requests)
 */
const getCustomLogLevel = (res: ServerResponse): LevelWithSilent => {
  const statusCode = res.statusCode;

  if (statusCode >= 500) {
    return "error";
  } else if (statusCode >= 400) {
    return "warn";
  }

  return "info";
};

/**
 * Determines if a request should be logged based on path and method
 * Filters out health checks and static file requests in production
 */
const shouldLogRequest = (req: Request): boolean => {
  const isProduction = process.env.NODE_ENV === "production";
  const url = req.url.toLowerCase();

  // Always log everything in non-production environments
  if (!isProduction) {
    return true;
  }

  // Skip health check endpoints in production (high volume, low value)
  if (
    url.includes("/health") ||
    url.includes("/ready") ||
    url.includes("/live")
  ) {
    return false;
  }

  // Skip common static file requests
  if (/\.(ico|png|jpg|jpeg|gif|svg|css|js|woff|woff2|ttf|eot)$/.test(url)) {
    return false;
  }

  return true;
};

/**
 * Calculates request duration in milliseconds
 */
const calculateDuration = (startTime: number | undefined): number => {
  if (!startTime) return 0;
  return Date.now() - startTime;
};

/**
 * Extracts user agent information safely
 */
const getUserAgent = (req: Request): string => {
  return req.get("user-agent") || "unknown";
};

const sanitizeRequestHeaders = (
  headers: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  if (!headers) {
    return {};
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "authorization" ||
      normalizedKey === "cookie" ||
      normalizedKey === "x-api-key"
    ) {
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
};

/**
 * Creates the HTTP request logging middleware for Express
 * Logs all incoming requests with timing, status, and metadata
 * 
 * Features:
 * - Request/response logging with timing
 * - Automatic log level based on status code
 * - Request ID tracking
 * - User agent parsing
 * - Response time metrics
 * - Filtering for health checks and static files
 */
export const createRequestLogger = () => {
  // In test mode, return a minimal middleware that doesn't log
  if (process.env.NODE_ENV === 'test') {
    return (req: Request, res: Response, next: NextFunction) => {
      // Minimal request processing for tests
      (req as any).startTime = Date.now();
      (req as any).id = req.requestId;
      next();
    };
  }
  
  const options: PinoHttpOptions = {
    logger,

    /**
     * Auto-logging disabled - we handle it manually for more control
     */
    autoLogging: {
      ignore: (req: IncomingMessage) => !shouldLogRequest(req as Request),
    },

    /**
     * Custom log level derivation
     */
    customLogLevel: (_req: IncomingMessage, res: ServerResponse) =>
      getCustomLogLevel(res),

    /**
     * Custom success message format
     */
    customSuccessMessage: (req: IncomingMessage, res: ServerResponse) => {
      const duration = calculateDuration((req as Request).startTime);
      const method = req.method || "UNKNOWN";
      const url = req.url || "/";
      return `${method} ${url} completed in ${duration}ms [${res.statusCode}]`;
    },

    /**
     * Custom error message format
     */
    customErrorMessage: (
      req: IncomingMessage,
      res: ServerResponse,
      err: Error
    ) => {
      const duration = calculateDuration((req as Request).startTime);
      const method = req.method || "UNKNOWN";
      const url = req.url || "/";
      return `${method} ${url} failed after ${duration}ms: ${err.message}`;
    },

    /**
     * Custom attribute keys for additional context
     */
    customAttributeKeys: {
      req: "request",
      res: "response",
      err: "error",
      responseTime: "responseTime",
    },

    /**
     * Custom request ID generation for traceability
     */
    genReqId: (req: any) => {
      if (typeof req.requestId === "string" && req.requestId.length > 0) {
        return req.requestId;
      }
      // Use existing request ID if present (from proxy/gateway)
      const existingId =
        req.headers["x-request-id"] || req.headers["x-correlation-id"];
      if (existingId && typeof existingId === "string") {
        return existingId;
      }

      // Generate new UUID v4 format
      return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    },

    /**
     * Custom serializers for request and response objects
     */
    serializers: {
      req: (req: Request) => ({
        id: req.id,
        apiKeyId: req.apiKeyId,
        method: req.method,
        url: req.originalUrl || req.url,
        query: req.query,
        params: req.params,
        headers: sanitizeRequestHeaders(req.headers as Record<string, unknown>),
        remoteAddress: req.ip,
        userAgent: req.get("user-agent"),
      }),
      res: (res: Response) => ({
        statusCode: res.statusCode,
        headers: res.getHeaders(),
        responseTime: (res as any).responseTime,
      }),
    },

    /**
     * Timestamp format for logs
     */
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  };

  return pinoHttp(options);
};

/**
 * Error logging middleware - captures unhandled errors with full context
 * Should be placed after all route handlers
 */
export const errorLoggerMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: any
) => {
  const requestId = req.requestId || req.id || "unknown";
  const duration = calculateDuration(req.startTime);

  logger.error(
    {
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
        code: err.code,
      },
      apiKeyId: req.apiKeyId,
      request: {
        id: requestId,
        method: req.method,
        url: req.originalUrl || req.url,
        headers: sanitizeRequestHeaders(req.headers as Record<string, unknown>),
        body: req.body,
        query: req.query,
        params: req.params,
      },
      response: {
        statusCode: res.statusCode,
      },
      duration_ms: duration,
      timestamp: new Date().toISOString(),
    },
    "Unhandled error occurred"
  );

  // Pass to next error handler
  next(err);
};
