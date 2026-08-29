/**
 * Type-safe error senders.
 *
 * These are the only functions that should emit the canonical error envelope
 * from a middleware/route directly (when calling `next(err)` is not
 * appropriate, e.g. handlers passed to third-party libraries).
 *
 * All senders accept *only known* taxonomy codes at compile time, resolve the
 * message through i18n `messageKey`s, and enforce the public/internal split:
 * internal codes are masked behind `INTERNAL_ERROR` and stripped of details in
 * production so they never leak backend state to clients.
 */
import type { Request, Response } from "express";
import type { AppError } from "./AppError.js";
import {
  ERROR_TAXONOMY,
  type ErrorCode,
  type ErrorType,
  isPublicError,
  type InternalErrorCode,
  type PublicErrorCode,
} from "./errorCodes.js";
import { resolveMessage, type SupportedLocale } from "../i18n/messageLoader.js";

/**
 * Options shared by all senders.
 */
export interface SendErrorOptions {
  /** Locale for i18n message resolution. Defaults to "en". */
  locale?: SupportedLocale;
  /** Optional structured context attached to `details` (stripped for internal codes in production). */
  details?: unknown;
}

function emitError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  errorMessage: string,
  options: SendErrorOptions | undefined,
): Response {
  const payload: {
    success: false;
    code: string;
    message: string;
    error: string;
    timestamp: string;
    details?: unknown;
  } = {
    success: false,
    code,
    message,
    error: errorMessage,
    timestamp: new Date().toISOString(),
  };
  if (options?.details !== undefined) {
    payload.details = options.details;
  }
  return res.status(statusCode).json(payload);
}

/**
 * A reusable adapter that resolves the taxonomy entry for a code and fails
 * loudly (throw) if the code is not a member of the requested scope.
 */
function taxonomyEntry<K extends ErrorCode>(
  code: K,
  expectedScope: "public" | "internal",
): (typeof ERROR_TAXONOMY)[K] {
  const entry = ERROR_TAXONOMY[code];
  if (!entry) {
    throw new Error(`Unknown error code: ${String(code)}`);
  }
  if (entry.scope !== expectedScope) {
    throw new Error(
      `Invalid ${expectedScope} error code: ${String(code)} (got scope "${entry.scope}")`,
    );
  }
  return entry;
}

/**
 * Type-safe sender for public errors only.
 *
 * Compile-time guarantee: only known public codes are accepted.
 * Runtime guarantee: the code must exist in the taxonomy with `scope: "public"`.
 *
 * @param res - Express response
 * @param code - Public error code (type-checked)
 * @param message - Human-readable message (also used as the `error` field)
 * @param options - locale / details
 */
export function sendPublicError(
  res: Response,
  code: PublicErrorCode,
  message: string,
  options?: SendErrorOptions,
): Response {
  const entry = taxonomyEntry(code, "public");
  const i18nMessage = resolveMessage(entry.messageKey, options?.locale);
  return emitError(res, entry.status, entry.code, i18nMessage, message, options);
}

/**
 * Type-safe sender for internal errors only.
 *
 * Internal errors are never exposed as-is: in production the code is masked to
 * `INTERNAL_ERROR`, the details are dropped, and the `error` field is generic.
 * In development the real code/details are preserved for debugging.
 *
 * @param res - Express response
 * @param code - Internal error code (type-checked)
 * @param message - Message for logging / development responses
 * @param options - locale / details
 */
export function sendInternalError(
  res: Response,
  code: InternalErrorCode,
  message: string,
  options?: SendErrorOptions,
): Response {
  const entry = taxonomyEntry(code, "internal");
  const isProduction = process.env.NODE_ENV === "production";
  const i18nMessage = resolveMessage(entry.messageKey, options?.locale);

  if (isProduction) {
    return emitError(res, entry.status, "INTERNAL_ERROR", i18nMessage, "Internal server error", {
      ...options,
      details: undefined,
    });
  }

  const payload: {
    success: false;
    code: string;
    message: string;
    error: string;
    timestamp: string;
    details?: unknown;
  } = {
    success: false,
    code: entry.code,
    message: i18nMessage,
    error: message,
    timestamp: new Date().toISOString(),
  };
  if (options?.details !== undefined) {
    payload.details = options.details;
  }
  return res.status(entry.status).json(payload);
}

/**
 * Generic type-safe sender accepting any known code. Routes public codes to
 * `sendPublicError` and internal codes to `sendInternalError`. Passing an
 * unknown code is a compile-time error (type safety) and a runtime throw.
 *
 * @param res - Express response
 * @param code - Any known taxonomy code (type-checked)
 * @param message - Human-readable message
 * @param options - locale / details
 */
export function sendError(
  res: Response,
  code: ErrorCode,
  message: string,
  options?: SendErrorOptions,
): Response {
  const entry: ErrorType | undefined = ERROR_TAXONOMY[code];
  if (!entry) {
    throw new Error(`Unknown error code: ${String(code)}`);
  }
  if (isPublicError(entry)) {
    return sendPublicError(res, code, message, options);
  }
  return sendInternalError(res, code, message, options);
}

/**
 * Emit the canonical error envelope from an `AppError` directly.
 *
 * Use this when the code path has an `AppError` instance (e.g. from a global
 * handler or when `next(err)` is not appropriate). It matches the shape
 * produced by the global error handler.
 *
 * @param res - Express response
 * @param err - AppError (or subclass) to emit
 * @param req - Optional request; attaches `requestId` when available
 */
export function sendErrorResponse(res: Response, err: AppError, req?: Request): Response {
  const envelope = err.toJSON();
  if (req) {
    const requestId = req.requestId ?? req.id;
    if (requestId !== undefined) {
      envelope.requestId = requestId;
    }
  }
  return res.status(err.statusCode).json(envelope);
}
