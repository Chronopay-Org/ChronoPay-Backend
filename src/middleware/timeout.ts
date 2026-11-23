import { Request, Response, NextFunction } from "express";
import { timeoutConfig } from "../config/timeouts.js";
import { logger } from "../utils/logger.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./requestId.js";

export interface TimeoutOptions {
  timeoutMs?: number;
}

export function timeoutMiddleware(options: TimeoutOptions = {}) {
  const timeoutMs = options.timeoutMs ?? timeoutConfig.http.defaultMs;

  return (req: Request, res: Response, next: NextFunction) => {
    // requestIdMiddleware already validated (or generated) the id; fall back to
    // resolving the raw header so a req id is never echoed or logged unvalidated.
    const requestId = req.requestId || resolveRequestId(req.header(REQUEST_ID_HEADER));
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      res.setHeader("X-Request-Id", String(requestId));
      res.status(503).json({
        success: false,
        error: "Request timed out. Please try again later.",
      });

      // Log with requestId, route, and duration
      logger.warn(
        { requestId, route: req.originalUrl, durationMs: timeoutMs },
        "request timed out",
      );
    }, timeoutMs);

    // Prevent leaking partial data
    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));

    // Prevent further processing if already timed out
    req.on("aborted", () => clearTimeout(timer));

    next();
  };
}
