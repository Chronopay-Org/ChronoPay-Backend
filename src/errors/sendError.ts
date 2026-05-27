import type { Request, Response } from "express";
import type { AppError } from "./AppError.js";

/**
 * Emit the canonical error envelope from a middleware/route directly.
 *
 * Use this when calling `next(err)` is not appropriate (e.g., handlers passed
 * to third-party libraries, or unit tests that mock `res`). The shape matches
 * what the global error handler emits.
 */
export function sendErrorResponse(
  res: Response,
  err: AppError,
  req?: Request,
): Response {
  const envelope = err.toJSON();
  if (req) {
    const requestId = req.requestId ?? req.id;
    if (requestId !== undefined) {
      envelope.requestId = requestId;
    }
  }
  return res.status(err.statusCode).json(envelope);
}
