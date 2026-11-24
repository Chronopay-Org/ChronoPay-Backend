/**
 * Global error handling middleware for ChronoPay API.
 *
 * Emits the canonical flat error envelope:
 *   { success: false, code, message?, error?, requestId?, timestamp, details?, stack? }
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
  MalformedJsonError,
  isAppError,
  getStatusCode,
  type AppErrorEnvelope,
} from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { logger } from "../utils/logger.js";

export interface ErrorHandlerOptions {
  logError?: (error: Error, req: Request) => void;
  includeStackTrace?: boolean;
  unknownErrorMessage?: string;
}

type ConfiguredErrorEnvelope = Omit<AppErrorEnvelope, "message"> & {
  message?: string;
};

function getRequestId(req: Request): string | undefined {
  return req.requestId ?? (typeof req.id === "string" ? req.id : undefined);
}

function withRequestContext(
  envelope: AppErrorEnvelope,
  req: Request,
): AppErrorEnvelope {
  const requestId = getRequestId(req);
  if (requestId !== undefined) {
    envelope.requestId = requestId;
  }
  return envelope;
}

function defaultLogError(error: Error, req: Request): void {
  const statusCode = isAppError(error) ? error.statusCode : 500;
  const requestId = getRequestId(req) ?? "unknown";
  logger.error(
    { err: error, requestId, method: req.method, url: req.url, statusCode },
    "request error",
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

    const requestId =
      req.requestId ?? (typeof req.id === "string" ? req.id : undefined);
    const statusCode = getStatusCode(err);

    let envelope: AppErrorEnvelope;
    const requestId = getRequestId(req);
    const statusCode = getStatusCode(err);

    let envelope: ConfiguredErrorEnvelope;

    if (isAppError(err)) {
      envelope = (err as AppError).toJSON();
    } else {
      envelope = {
        success: false,
        code: ERROR_CODES.INTERNAL_ERROR.code,
        message: unknownErrorMessage,
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
  res: Response,
) {
  const error = new AppError(
    `Route not found: ${req.method} ${req.path}`,
    ERROR_CODES.NOT_FOUND.status,
    ERROR_CODES.NOT_FOUND.code,
    true,
  );
  return res
    .status(error.statusCode)
    .json(withRequestContext(error.toJSON(), req));
}

export const notFoundMiddleware: RequestHandler = notFoundHandler;

export const errorHandler = createErrorHandler();

export function jsonParseErrorHandler(
  err: Error & { status?: number; type?: string },
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (err.type === "entity.parse.failed") {
    const wrapped = new MalformedJsonError();
    return res
      .status(wrapped.statusCode)
      .json(withRequestContext(wrapped.toJSON(), req));
  }

  if (err.type === "entity.too.large") {
    const wrapped = new AppError(
      "Request body exceeds the maximum allowed size.",
      413,
      "PAYLOAD_TOO_LARGE",
      true,
    );
    return res
      .status(wrapped.statusCode)
      .json(withRequestContext(wrapped.toJSON(), req));
  }

  if (
    err.type === "charset.unsupported" ||
    err.type === "encoding.unsupported"
  ) {
    const wrapped = new AppError(
      "Unsupported request body encoding.",
      ERROR_CODES.UNSUPPORTED_MEDIA_TYPE.status,
      ERROR_CODES.UNSUPPORTED_MEDIA_TYPE.code,
      true,
    );
    return res
      .status(wrapped.statusCode)
      .json(withRequestContext(wrapped.toJSON(), req));
  }

  return next(err);
}

export function genericErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  logger.error({ err, requestId: req.requestId ?? req.id }, "unhandled error");
  if (err instanceof Error && "statusCode" in err && "code" in err) {
    const error = err as Error & {
      statusCode?: unknown;
      code?: unknown;
      toJSON?: unknown;
    };
    if (
      typeof error.statusCode === "number" &&
      typeof error.code === "string" &&
      typeof error.toJSON === "function"
    ) {
      return res
        .status(error.statusCode)
        .json(withRequestContext((error as AppError).toJSON(), req));
    }
  }

  const fallback: AppErrorEnvelope = {
    success: false,
    code: ERROR_CODES.INTERNAL_ERROR.code,
    message: "Internal server error",
    error: "Internal server error",
    timestamp: new Date().toISOString(),
  };
  return res.status(500).json(withRequestContext(fallback, req));
}
