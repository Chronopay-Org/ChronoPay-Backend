import { Request, Response, NextFunction } from "express";

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Hide internal errors and stack traces
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({
    success: false,
    error: "Internal server error",
  });
}
