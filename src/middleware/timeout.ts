import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { timeoutConfig } from "../config/timeouts.js";
import { logger } from "../utils/logger.js";

export interface TimeoutOptions {
  timeoutMs?: number;
}

declare global {
  namespace Express {
    interface Request {
      abortSignal?: AbortSignal;
    }
  }
}

export function timeoutMiddleware(options: TimeoutOptions = {}) {
  const timeoutMs = options.timeoutMs ?? timeoutConfig.http.defaultMs;

  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = req.headers["x-request-id"] || uuidv4();
    const controller = new AbortController();
    req.abortSignal = controller.signal;
    res.locals.timedOut = false;

    let loggedLateWrite = false;
    const logLateWriteOnce = (method: "json" | "send" | "end") => {
      if (loggedLateWrite) return;
      loggedLateWrite = true;
      logger.debug(
        { requestId, route: req.originalUrl, method, durationMs: timeoutMs },
        "ignoring response write after request timeout",
      );
    };

    const wrapWriteMethod = <T extends (...args: never[]) => unknown>(
      method: "json" | "send" | "end",
      originalFn: T | undefined,
    ) => {
      if (typeof originalFn !== "function") return;
      const wrapped = function (this: Response, ...args: Parameters<T>) {
        if (res.locals.timedOut || res.headersSent || res.writableEnded) {
          logLateWriteOnce(method);
          return res;
        }
        return originalFn.apply(this, args);
      };
      (res as unknown as Record<string, unknown>)[method] = wrapped;
    };

    const originalJson = typeof res.json === "function" ? res.json.bind(res) : undefined;
    const originalSend = typeof res.send === "function" ? res.send.bind(res) : undefined;
    const originalEnd = typeof res.end === "function" ? res.end.bind(res) : undefined;

    wrapWriteMethod("json", originalJson);
    wrapWriteMethod("send", originalSend);
    wrapWriteMethod("end", originalEnd);

    const cleanup = (abortSignal = false) => {
      clearTimeout(timer);
      if (abortSignal && !controller.signal.aborted) {
        controller.abort();
      }
    };

    const timer = setTimeout(() => {
      res.locals.timedOut = true;
      if (!controller.signal.aborted) {
        controller.abort();
      }

      if (res.headersSent) return;

      res.setHeader("X-Request-Id", String(requestId));
      res.status(503);
      if (originalJson) {
        originalJson({
          success: false,
          error: "Request timed out. Please try again later.",
        });
      }

      // Log with requestId, route, and duration
      logger.warn(
        { requestId, route: req.originalUrl, durationMs: timeoutMs },
        "request timed out",
      );
    }, timeoutMs);

    // Prevent leaking partial data
    res.on("finish", () => cleanup(false));
    res.on("close", () => cleanup(true));

    // Prevent further processing if already timed out
    req.on("aborted", () => cleanup(true));

    next();
  };
}