import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { timeoutConfig } from "../config/timeouts.js";

export interface TimeoutOptions {
  timeoutMs?: number;
}

export function timeoutMiddleware(options: TimeoutOptions = {}) {
  const timeoutMs = options.timeoutMs ?? timeoutConfig.http.defaultMs;

  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = req.headers["x-request-id"] || uuidv4();
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      res.setHeader("X-Request-Id", String(requestId));
      res.status(503).json({
        success: false,
        error: "Request timed out. Please try again later.",
      });

      // Log with requestId, route, and duration
      console.warn(
        `[TIMEOUT] requestId=${requestId} route=${req.originalUrl} duration=${timeoutMs}ms`,
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
