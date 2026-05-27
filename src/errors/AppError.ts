/**
 * Custom error classes for ChronoPay API.
 *
 * Every subclass binds to a canonical entry in `ERROR_CODES`. The error
 * envelope emitted on the wire is the flat shape produced by `toJSON()`:
 *
 *   { success: false, code, error, requestId?, timestamp, details? }
 *
 * See `docs/error-codes.md` for the full taxonomy.
 */

import { ERROR_CODES, type ErrorCodeString } from "./errorCodes.js";

export interface AppErrorEnvelope {
  success: false;
  code: ErrorCodeString | string;
  error: string;
  timestamp: string;
  requestId?: string;
  details?: unknown;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly timestamp: string;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = ERROR_CODES.INTERNAL_ERROR.code,
    isOperational: boolean = true,
    details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();
    if (details !== undefined) {
      this.details = details;
    }

    if (process.env.NODE_ENV !== "production") {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): AppErrorEnvelope {
    const envelope: AppErrorEnvelope = {
      success: false,
      code: this.code,
      error: this.message,
      timestamp: this.timestamp,
    };
    if (this.details !== undefined) {
      envelope.details = this.details;
    }
    return envelope;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string = "Bad Request", details?: unknown) {
    super(message, ERROR_CODES.BAD_REQUEST.status, ERROR_CODES.BAD_REQUEST.code, true, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string = "Validation failed", details?: unknown) {
    super(
      message,
      ERROR_CODES.VALIDATION_ERROR.status,
      ERROR_CODES.VALIDATION_ERROR.code,
      true,
      details,
    );
  }
}

export class MissingRequiredFieldError extends AppError {
  constructor(field: string) {
    super(
      `Missing required field: ${field}`,
      ERROR_CODES.MISSING_REQUIRED_FIELD.status,
      ERROR_CODES.MISSING_REQUIRED_FIELD.code,
      true,
      { field },
    );
  }
}

export class MalformedJsonError extends AppError {
  constructor(message: string = "Malformed JSON payload") {
    super(
      message,
      ERROR_CODES.MALFORMED_JSON.status,
      ERROR_CODES.MALFORMED_JSON.code,
      true,
    );
  }
}

export class UnauthorizedError extends AppError {
  constructor(
    message: string = "Unauthorized",
    code: string = ERROR_CODES.UNAUTHORIZED.code,
  ) {
    super(message, ERROR_CODES.UNAUTHORIZED.status, code, true);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message: string = "Forbidden",
    code: string = ERROR_CODES.FORBIDDEN.code,
  ) {
    super(message, ERROR_CODES.FORBIDDEN.status, code, true);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found") {
    super(message, ERROR_CODES.NOT_FOUND.status, ERROR_CODES.NOT_FOUND.code, true);
  }
}

export class ConflictError extends AppError {
  constructor(
    message: string = "Conflict",
    code: string = ERROR_CODES.CONFLICT.code,
  ) {
    super(message, ERROR_CODES.CONFLICT.status, code, true);
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(
    message: string = "Unprocessable Entity",
    code: string = ERROR_CODES.UNPROCESSABLE_ENTITY.code,
  ) {
    super(message, ERROR_CODES.UNPROCESSABLE_ENTITY.status, code, true);
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = "Too many requests, please try again later.") {
    super(
      message,
      ERROR_CODES.RATE_LIMITED.status,
      ERROR_CODES.RATE_LIMITED.code,
      true,
    );
  }
}

export class IdempotencyError extends AppError {
  constructor(
    message: string,
    code:
      | typeof ERROR_CODES.IDEMPOTENCY_KEY_INVALID.code
      | typeof ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.code
      | typeof ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH.code,
  ) {
    const status =
      code === ERROR_CODES.IDEMPOTENCY_KEY_INVALID.code
        ? ERROR_CODES.IDEMPOTENCY_KEY_INVALID.status
        : code === ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.code
          ? ERROR_CODES.IDEMPOTENCY_IN_PROGRESS.status
          : ERROR_CODES.IDEMPOTENCY_KEY_MISMATCH.status;
    super(message, status, code, true);
  }
}

export class DatabaseError extends AppError {
  constructor(message: string = "Database operation failed", details?: unknown) {
    super(
      message,
      ERROR_CODES.DB_ERROR.status,
      ERROR_CODES.DB_ERROR.code,
      false,
      details,
    );
  }
}

export class InternalServerError extends AppError {
  constructor(message: string = "Internal Server Error") {
    super(
      message,
      ERROR_CODES.INTERNAL_ERROR.status,
      ERROR_CODES.INTERNAL_ERROR.code,
      process.env.NODE_ENV !== "production",
    );
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(
    message: string = "Service Unavailable",
    code: string = ERROR_CODES.SERVICE_UNAVAILABLE.code,
  ) {
    super(message, ERROR_CODES.SERVICE_UNAVAILABLE.status, code, true);
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string) {
    super(
      message,
      ERROR_CODES.CONFIGURATION_ERROR.status,
      ERROR_CODES.CONFIGURATION_ERROR.code,
      true,
    );
  }
}

export class ContentNegotiationError extends AppError {
  constructor(
    statusCode: 415 | 406,
    code: string,
    message: string,
  ) {
    super(message, statusCode, code, true);
  }
}

export function isAppError(error: unknown): error is AppError {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    "code" in error &&
    "isOperational" in error
  );
}

export function getStatusCode(error: unknown): number {
  if (isAppError(error)) {
    return error.statusCode;
  }
  if (error instanceof Error) {
    return 500;
  }
  return 500;
}
