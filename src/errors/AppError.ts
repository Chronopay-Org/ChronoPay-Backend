/**
 * Custom error classes for ChronoPay API
 *
 * These errors provide structured error handling across the application
 * with proper HTTP status codes and error categorization.
 */

/**
 * Base application error with HTTP status code support
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly timestamp: string;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = "INTERNAL_ERROR",
    isOperational: boolean = true,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();

    // Maintains proper stack trace for where error was thrown (only in dev)
    if (process.env.NODE_ENV !== "production") {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert error to JSON-serializable object
   */
  toJSON() {
    return {
      success: false,
      error: {
        message: this.message,
        code: this.code,
        timestamp: this.timestamp,
      },
    };
  }
}

/**
 * Bad Request Error (400)
 * Used for invalid inputs, missing fields, malformed requests
 */
export class BadRequestError extends AppError {
  constructor(message: string = "Bad Request") {
    super(message, 400, "BAD_REQUEST", true);
  }
}

/**
 * Unauthorized Error (401)
 * Used for missing or invalid authentication
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED", true);
  }
}

/**
 * Forbidden Error (403)
 * Used when user lacks permission for the requested resource
 */
export class ForbiddenError extends AppError {
  constructor(message: string = "Forbidden") {
    super(message, 403, "FORBIDDEN", true);
  }
}

/**
 * Not Found Error (404)
 * Used when requested resource doesn't exist
 */
export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found") {
    super(message, 404, "NOT_FOUND", true);
  }
}

/**
 * Conflict Error (409)
 * Used for resource conflicts (e.g., duplicate entries)
 */
export class ConflictError extends AppError {
  constructor(message: string = "Conflict") {
    super(message, 409, "CONFLICT", true);
  }
}

/**
 * Unprocessable Entity Error (422)
 * Used for validation errors that can't be processed
 */
export class UnprocessableEntityError extends AppError {
  constructor(message: string = "Unprocessable Entity") {
    super(message, 422, "UNPROCESSABLE_ENTITY", true);
  }
}

/**
 * Internal Server Error (500)
 * Used for unexpected server errors
 * Note: isOperational is false by default to hide internal details in production
 */
export class InternalServerError extends AppError {
  constructor(message: string = "Internal Server Error") {
    super(
      message,
      500,
      "INTERNAL_ERROR",
      process.env.NODE_ENV !== "production",
    );
  }
}

/**
 * Service Unavailable Error (503)
 * Used when service is temporarily unavailable
 */
export class ServiceUnavailableError extends AppError {
  constructor(message: string = "Service Unavailable") {
    super(message, 503, "SERVICE_UNAVAILABLE", true);
  }
}

/**
 * Content Negotiation Error (415/406)
 * Used for Content-Type or Accept header validation failures
 */
export class ContentNegotiationError extends AppError {
  constructor(
    statusCode: 415 | 406,
    code: string,
    message: string,
  ) {
    super(message, statusCode, code, true);
  }
}

/**
 * Type guard to check if error is an AppError
 */
export function isAppError(error: unknown): error is AppError {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    "code" in error &&
    "isOperational" in error
  );
}

/**
 * Extract status code from any error
 */
export function getStatusCode(error: unknown): number {
  if (isAppError(error)) {
    return error.statusCode;
  }
  if (error instanceof Error) {
    return 500;
  }
  return 500;
}
