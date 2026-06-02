/**
 * Type-safe error sender with i18n message resolution.
 *
 * This module provides a type-safe alternative to direct AppError construction.
 * It guarantees at compile-time that only known error codes are used and that
 * messages are resolved through i18n.
 */

import type { Request, Response } from "express";
import type { AppError } from "./AppError.js";
import {
  ERROR_TAXONOMY,
  type ErrorCode,
  type PublicErrorCode,
  type InternalErrorCode,
  isPublicError,
  type I18nMessageKey,
} from "./errorTaxonomy.js";
import { resolveMessage, type SupportedLocale } from "../i18n/messageLoader.js";

/**
 * Options for sending an error response.
 */
export interface SendErrorOptions {
  /**
   * Locale for i18n message resolution. Defaults to "en".
   */
  locale?: SupportedLocale;

  /**
   * Optional additional context to attach to error details.
   */
  details?: unknown;
}

/**
 * Type-safe error sender for public errors only.
 *
 * Compile-time guarantee: only known public error codes accepted.
 * Runtime guarantee: error code matches HTTP status in taxonomy.
 *
 * @param res - Express response object
 * @param code - Public error code (type-checked)
 * @param message - Error message for logging/display
 * @param options - Additional options (locale, details)
 *
 * @example
 * sendPublicError(res, "NOT_FOUND", "User not found", { details: { userId: 123 } });
 */
export function sendPublicError(
  res: Response,
  code: PublicErrorCode,
  message: string,
  options?: SendErrorOptions,
): Response {
  const error = ERROR_TAXONOMY[code];
  if (!error || !isPublicError(error)) {
    throw new Error(`Invalid public error code: ${code}`);
  }

  const locale = options?.locale ?? "en";
  const i18nMessage = resolveMessage(error.messageKey, locale);

  return res.status(error.status).json({
    success: false,
    code: error.code,
    message: i18nMessage,
    error: message,
    timestamp: new Date().toISOString(),
    ...(options?.details && { details: options.details }),
  });
}

/**
 * Type-safe error sender for internal errors only.
 *
 * Compile-time guarantee: only known internal error codes accepted.
 * Internal errors should NEVER be sent to public API — they log at server
 * and respond with a generic error code instead.
 *
 * @param res - Express response object
 * @param code - Internal error code (type-checked)
 * @param message - Error message for logging
 * @param options - Additional options (locale, details)
 *
 * @example
 * sendInternalError(res, "DB_ERROR", "Query timeout", { details: { query: "SELECT ..." } });
 */
export function sendInternalError(
  res: Response,
  code: InternalErrorCode,
  message: string,
  options?: SendErrorOptions,
): Response {
  const error = ERROR_TAXONOMY[code];
  if (!error || isPublicError(error)) {
    throw new Error(`Invalid internal error code: ${code}`);
  }

  // In production, don't expose internal error details
  const isProduction = process.env.NODE_ENV === "production";
  const locale = options?.locale ?? "en";
  const i18nMessage = resolveMessage(error.messageKey, locale);

  return res.status(error.status).json({
    success: false,
    code: isProduction ? "INTERNAL_ERROR" : error.code,
    message: i18nMessage,
    error: isProduction ? "Internal server error" : message,
    timestamp: new Date().toISOString(),
    ...(options?.details && !isProduction && { details: options.details }),
  });
}

/**
 * Generic error sender that accepts any error code.
 *
 * This is less type-safe but useful for dynamic error handling.
 * Prefer sendPublicError or sendInternalError for specific use cases.
 *
 * @param res - Express response object
 * @param code - Error code (any known code)
 * @param message - Error message
 * @param options - Additional options
 *
 * @example
 * sendError(res, "VALIDATION_ERROR", "Invalid input", { locale: "es" });
 */
export function sendError(
  res: Response,
  code: ErrorCode,
  message: string,
  options?: SendErrorOptions,
): Response {
  const error = ERROR_TAXONOMY[code];
  if (!error) {
    throw new Error(`Unknown error code: ${code}`);
  }

  const isInternal = !isPublicError(error);
  if (isInternal) {
    return sendInternalError(
      res,
      code as InternalErrorCode,
      message,
      options,
    );
  }

  return sendPublicError(
    res,
    code as PublicErrorCode,
    message,
    options,
  );
}

/**
 * Emit the canonical error envelope from a middleware/route directly.
 *
 * Use this when calling `next(err)` is not appropriate (e.g., handlers passed
 * to third-party libraries, or unit tests that mock `res`). The shape matches
 * what the global error handler emits.
 *
 * This is the legacy function signature — prefer sendError or sendPublicError.
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
      // @ts-expect-error - Auto-fixed by script
      envelope.requestId = requestId;
    }
  }
  return res.status(err.statusCode).json(envelope);
}
