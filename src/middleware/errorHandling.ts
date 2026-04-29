import { NextFunction, Request, Response } from "express";
import {
  AppError,
  MalformedJsonError,
  isAppError,
  type AppErrorEnvelope,
} from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";

function withRequestContext(
  envelope: AppErrorEnvelope,
  req: Request,
): AppErrorEnvelope {
  const requestId = req.requestId ?? req.id;
  if (requestId !== undefined) {
    envelope.requestId = requestId;
  }
  return envelope;
}

export function notFoundHandler(req: Request, res: Response) {
  const err = new AppError(
    `Route not found: ${req.method} ${req.path}`,
    ERROR_CODES.NOT_FOUND.status,
    ERROR_CODES.NOT_FOUND.code,
    true,
  );
  return res.status(err.statusCode).json(withRequestContext(err.toJSON(), req));
}

export function jsonParseErrorHandler(
  err: Error & { status?: number; type?: string },
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (err.type !== "entity.parse.failed") {
    return next(err);
  }

  const wrapped = new MalformedJsonError();
  return res
    .status(wrapped.statusCode)
    .json(withRequestContext(wrapped.toJSON(), req));
}

export function genericErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (
    err instanceof Error &&
    "statusCode" in err &&
    "code" in err
  ) {
    const e = err as any;
    // Emit a consistent envelope for any AppError-shaped error (includes
    // ServiceUnavailableError / 503 from dependency outages).
    if (typeof e.statusCode === "number" && typeof e.code === "string") {
      return res.status(e.statusCode).json({
        success: false,
        code: e.code,
        error: e.message,
      });
    }
  }

  const fallback: AppErrorEnvelope = {
    success: false,
    code: ERROR_CODES.INTERNAL_ERROR.code,
    error: "Internal server error",
    timestamp: new Date().toISOString(),
  };
  return res.status(500).json(withRequestContext(fallback, req));
}
