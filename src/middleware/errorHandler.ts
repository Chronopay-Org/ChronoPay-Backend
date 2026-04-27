/**
 * Global Error Handling Middleware for ChronoPay API
 *
 * This middleware provides centralized error handling across the application.
 * It catches all errors thrown in the application and returns appropriate
 * HTTP responses based on the error type.
 *
 * Features:
 * - Structured error responses
 * - Security: Hides internal error details in production
 * - Logging: Supports external logging integration
 * - Type-safe error handling
 */

import {
  Request,
  Response,
  NextFunction,
  ErrorRequestHandler,
  RequestHandler,
} from "express";
import { AppError, isAppError, getStatusCode, ContentNegotiationError } from "../errors/AppError.js";

/**
 * Configuration options for error handling middleware
 */
export interface ErrorHandlerOptions {
  /**
   * Function to handle error logging
   * @param error - The error that occurred
   * @param req - The incoming request
   */
  logError?: (error: Error, req: Request) => void;

  /**
   * Whether to include stack trace in response (development only)
   * @default process.env.NODE_ENV !== "production"
   */
  includeStackTrace?: boolean;

  /**
   * Custom error message for unknown errors
   * @default "An unexpected error occurred"
   */
  unknownErrorMessage?: string;
}

/**
 * Default logging function
 */
function defaultLogError(error: Error, req: Request): void {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.url;
  const statusCode = isAppError(error) ? error.statusCode : 500;
  const requestId = req.requestId ?? req.id ?? "unknown";

  console.error(
    `[${timestamp}] ${method} ${url} - ${statusCode} [requestId=${requestId}]: ${error.message}`,
    isAppError(error) && error.statusCode >= 500 ? error.stack : "",
  );
}

/**
 * Global error handling middleware factory
 *
 * @param options - Configuration options for the middleware
 * @returns Express error handling middleware
 *
 * @example
 * ```typescript
 * const errorHandler = createErrorHandler({
 *   logError: (err, req) => logger.error(err, req),
 *   includeStackTrace: false
 * });
 * app.use(errorHandler);
 * ```
 */
export function createErrorHandler(
  options: ErrorHandlerOptions = {},
): ErrorRequestHandler {
  const {
    logError = defaultLogError,
    includeStackTrace = process.env.NODE_ENV !== "production",
    unknownErrorMessage = "An unexpected error occurred",
  } = options;

  // Express error handler with 4 parameters
  return (
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction,
  ): void => {
    // Log the error
    logError(err, req);

    // Handle ContentNegotiationError with flat error envelope
    if (err instanceof ContentNegotiationError) {
      res.status(err.statusCode).json({
        success: false,
        code: err.code,
        error: err.message,
      });
      return;
    }

    // Determine if this is an operational error (expected)
    const isOperational = isAppError(err) && err.isOperational;

    // Get appropriate status code
    const statusCode = getStatusCode(err);
    const requestId = req.requestId ?? req.id;

    // Build error response
    let errorResponse: Record<string, unknown>;

    if (isAppError(err)) {
      // Use the structured error from our custom error classes
      errorResponse = err.toJSON();
      if (
        typeof errorResponse === "object" &&
        errorResponse !== null &&
        "error" in errorResponse &&
        typeof (errorResponse as { error?: unknown }).error === "object" &&
        (errorResponse as { error?: unknown }).error !== null
      ) {
        ((errorResponse as { error: Record<string, unknown> }).error).requestId = requestId;
      }
    } else {
      // Handle unknown/unexpected errors
      const errorObj: Record<string, unknown> = {
        message: unknownErrorMessage,
        code: "INTERNAL_ERROR",
        timestamp: new Date().toISOString(),
        requestId,
      };

      // Add stack trace in development only
      if (includeStackTrace && err.stack) {
        errorObj.stack = err.stack;
      }

      errorResponse = {
        success: false,
        error: errorObj,
      };
    }

    // Send error response
    res.status(statusCode).json(errorResponse);
  };
}

/**
 * Async route handler wrapper
 *
 * Wraps async route handlers to automatically catch errors and pass them
 * to the error handling middleware.
 *
 * @param fn - Async route handler function
 * @returns Wrapped function with error handling
 *
 * @example
 * ```typescript
 * app.get('/api/users', asyncErrorHandler(async (req, res) => {
 *   const users = await getUsers();
 *   res.json(users);
 * }));
 * ```
 */
export function asyncErrorHandler<T extends RequestHandler>(fn: T): T {
  // Return a new function that wraps the original
  return ((req: Request, res: Response, next: NextFunction) => {
    // Promise.resolve ensures fn can return either sync or async result
    Promise.resolve(fn(req, res, next)).catch(next);
  }) as T;
}

/**
 * Not Found handler for unmatched routes
 *
 * @param req - The incoming request
 * @param res - The response object
 * @param next - The next middleware function
 */
export function notFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const error = new AppError(
    `Route ${req.method} ${req.originalUrl} not found`,
    404,
    "NOT_FOUND",
    true,
  );
  next(error);
}

/**
 * 404 Handler middleware for unmatched routes
 */
export const notFoundMiddleware: RequestHandler = notFoundHandler;

// Default error handler instance
export const errorHandler = createErrorHandler();
