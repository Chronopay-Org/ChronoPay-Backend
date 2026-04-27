import { NextFunction, Request, Response } from "express";

export function notFoundHandler(req: Request, res: Response) {
  return res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
  });
}

export function jsonParseErrorHandler(
  err: Error & { status?: number; type?: string },
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (err.type !== "entity.parse.failed") {
    return next(err);
  }

  return res.status(400).json({
    success: false,
    error: "Malformed JSON payload",
  });
}

export function genericErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (
    err instanceof Error &&
    "statusCode" in err &&
    "code" in err
  ) {
    const e = err as any;
    if (
      (e.statusCode === 415 || e.statusCode === 406) &&
      (e.code === "UNSUPPORTED_MEDIA_TYPE" || e.code === "NOT_ACCEPTABLE")
    ) {
      return res.status(e.statusCode).json({
        success: false,
        code: e.code,
        error: e.message,
      });
    }
  }

  return res.status(500).json({
    success: false,
    error: "Internal server error",
  });
}
