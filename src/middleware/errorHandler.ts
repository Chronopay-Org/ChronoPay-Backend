/**
 * Global error handling middleware for ChronoPay API.
 *
 * Emits the canonical flat error envelope:
 *   { success: false, code, error, requestId?, timestamp, details?, stack? }
 *
 * `stack` is included only when NODE_ENV !== "production".
 */

import {
  Request,
  Response,
  NextFunction,
  ErrorRequestHandler,
  RequestHandler,
} from "express";
import {
  AppError,
  isAppError,
  getStatusCode,
  type AppErrorEnvelope,
} from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";

export interface ErrorHandlerOptions {
  logError?: (error: Error, req: Request) => void;
  includeStackTrace?: boolean;
  unknownErrorMessage?: string;
}

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

export function createErrorHandler(
  options: ErrorHandlerOptions = {},
): ErrorRequestHandler {
  const {
    logError = defaultLogError,
    includeStackTrace = process.env.NODE_ENV !== "production",
    unknownErrorMessage = "An unexpected error occurred",
  } = options;

  return (
    err: Error,
    req: Request,
    res: Response,
    _next: NextFunction,
  ): void => {
    logError(err, req);

    const requestId = req.requestId ?? req.id;
    const statusCode = getStatusCode(err);

    let envelope: AppErrorEnvelope & { stack?: string };

    if (isAppError(err)) {
      envelope = (err as AppError).toJSON();
    } else {
      envelope = {
        success: false,
        code: ERROR_CODES.INTERNAL_ERROR.code,
        error: unknownErrorMessage,
        timestamp: new Date().toISOString(),
      };
    }

    if (requestId !== undefined) {
      envelope.requestId = requestId;
    }

    if (!isAppError(err) && includeStackTrace && err.stack) {
      envelope.stack = err.stack;
    }

    res.status(statusCode).json(envelope);
  };
}

export function asyncErrorHandler<T extends RequestHandler>(fn: T): T {
  return ((req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  }) as T;
}

export function notFoundHandler(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const error = new AppError(
    `Route ${req.method} ${req.originalUrl} not found`,
    ERROR_CODES.NOT_FOUND.status,
    ERROR_CODES.NOT_FOUND.code,
    true,
  );
  next(error);
}

export const notFoundMiddleware: RequestHandler = notFoundHandler;

export const errorHandler = createErrorHandler();
