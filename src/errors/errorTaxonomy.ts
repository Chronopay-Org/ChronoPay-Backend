/**
 * Canonical ChronoPay API error code taxonomy with typed public/internal split.
 *
 * Error codes are organized as a discriminated union where:
 * - PUBLIC codes: stable contract, safe to expose to API clients
 * - INTERNAL codes: transient details, never exposed on public API surface
 *
 * Every error response that exits the API surface MUST use a PUBLIC code.
 * INTERNAL codes are used only in logging and internal error handling.
 */

/**
 * i18n message key type - maps to locales/errors/[lang].json entries.
 * Example: "errors.validation.missing_field"
 */
export type I18nMessageKey = string & { readonly __brand: "I18nMessageKey" };

export function createMessageKey(key: string): I18nMessageKey {
  return key as I18nMessageKey;
}

/**
 * Public error codes: stable contract, exposed to API clients.
 * These should never change HTTP status or semantics within a major version.
 */
export type PublicErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_PAYLOAD"
  | "MALFORMED_JSON"
  | "UNAUTHORIZED"
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_TOKEN"
  | "INVALID_API_KEY"
  | "INVALID_SIGNATURE"
  | "INVALID_TIMESTAMP"
  | "TIMESTAMP_OUT_OF_SKEW"
  | "FORBIDDEN"
  | "INSUFFICIENT_PERMISSIONS"
  | "INVALID_ROLE"
  | "RATE_LIMITED"
  | "FEATURE_DISABLED"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "IDEMPOTENCY_KEY_MISMATCH"
  | "REPLAY_DETECTED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "NOT_ACCEPTABLE"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE_ENTITY";

/**
 * Internal error codes: implementation details, never exposed to public API.
 * Used for internal logging and operational monitoring.
 */
export type InternalErrorCode =
  | "DB_ERROR"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "CONFIGURATION_ERROR"
  | "FEATURE_FLAG_EVALUATION_ERROR";

/**
 * Union of all known error codes (public + internal).
 */
export type ErrorCode = PublicErrorCode | InternalErrorCode;

/**
 * Discriminated union for public errors.
 * Statically guarantees each code maps to correct HTTP status.
 */
export type PublicError =
  // Validation (400 / 422)
  | { readonly code: "BAD_REQUEST"; readonly status: 400; readonly messageKey: I18nMessageKey }
  | { readonly code: "VALIDATION_ERROR"; readonly status: 422; readonly messageKey: I18nMessageKey }
  | { readonly code: "MISSING_REQUIRED_FIELD"; readonly status: 400; readonly messageKey: I18nMessageKey }
  | { readonly code: "INVALID_PAYLOAD"; readonly status: 400; readonly messageKey: I18nMessageKey }
  | { readonly code: "MALFORMED_JSON"; readonly status: 400; readonly messageKey: I18nMessageKey }
  // Authentication (401)
  | { readonly code: "UNAUTHORIZED"; readonly status: 401; readonly messageKey: I18nMessageKey }
  | { readonly code: "AUTHENTICATION_REQUIRED"; readonly status: 401; readonly messageKey: I18nMessageKey }
  | { readonly code: "INVALID_TOKEN"; readonly status: 401; readonly messageKey: I18nMessageKey }
  | { readonly code: "INVALID_API_KEY"; readonly status: 401; readonly messageKey: I18nMessageKey }
  | { readonly code: "INVALID_SIGNATURE"; readonly status: 401; readonly messageKey: I18nMessageKey }
  | { readonly code: "INVALID_TIMESTAMP"; readonly status: 401; readonly messageKey: I18nMessageKey }
  | { readonly code: "TIMESTAMP_OUT_OF_SKEW"; readonly status: 401; readonly messageKey: I18nMessageKey }
  // Authorization (403)
  | { readonly code: "FORBIDDEN"; readonly status: 403; readonly messageKey: I18nMessageKey }
  | { readonly code: "INSUFFICIENT_PERMISSIONS"; readonly status: 403; readonly messageKey: I18nMessageKey }
  | { readonly code: "INVALID_ROLE"; readonly status: 400; readonly messageKey: I18nMessageKey }
  // Rate limiting (429)
  | { readonly code: "RATE_LIMITED"; readonly status: 429; readonly messageKey: I18nMessageKey }
  // Feature flags (503)
  | { readonly code: "FEATURE_DISABLED"; readonly status: 503; readonly messageKey: I18nMessageKey }
  // Idempotency / replay (400 / 409 / 422)
  | { readonly code: "IDEMPOTENCY_KEY_INVALID"; readonly status: 400; readonly messageKey: I18nMessageKey }
  | { readonly code: "IDEMPOTENCY_IN_PROGRESS"; readonly status: 409; readonly messageKey: I18nMessageKey }
  | { readonly code: "IDEMPOTENCY_KEY_MISMATCH"; readonly status: 422; readonly messageKey: I18nMessageKey }
  | { readonly code: "REPLAY_DETECTED"; readonly status: 409; readonly messageKey: I18nMessageKey }
  // Content negotiation (406 / 415)
  | { readonly code: "UNSUPPORTED_MEDIA_TYPE"; readonly status: 415; readonly messageKey: I18nMessageKey }
  | { readonly code: "NOT_ACCEPTABLE"; readonly status: 406; readonly messageKey: I18nMessageKey }
  // State / lifecycle (404 / 409 / 422)
  | { readonly code: "NOT_FOUND"; readonly status: 404; readonly messageKey: I18nMessageKey }
  | { readonly code: "CONFLICT"; readonly status: 409; readonly messageKey: I18nMessageKey }
  | { readonly code: "UNPROCESSABLE_ENTITY"; readonly status: 422; readonly messageKey: I18nMessageKey };

/**
 * Discriminated union for internal errors.
 * These should never reach public API surface.
 */
export type InternalError =
  | { readonly code: "DB_ERROR"; readonly status: 500; readonly messageKey: I18nMessageKey }
  | { readonly code: "INTERNAL_ERROR"; readonly status: 500; readonly messageKey: I18nMessageKey }
  | { readonly code: "SERVICE_UNAVAILABLE"; readonly status: 503; readonly messageKey: I18nMessageKey }
  | { readonly code: "CONFIGURATION_ERROR"; readonly status: 503; readonly messageKey: I18nMessageKey }
  | { readonly code: "FEATURE_FLAG_EVALUATION_ERROR"; readonly status: 500; readonly messageKey: I18nMessageKey };

/**
 * Union of all error types (public + internal).
 */
export type ErrorType = PublicError | InternalError;

/**
 * Type guard: check if error is a public error.
 */
export function isPublicError(error: ErrorType): error is PublicError {
  const publicCodes: PublicErrorCode[] = [
    "BAD_REQUEST",
    "VALIDATION_ERROR",
    "MISSING_REQUIRED_FIELD",
    "INVALID_PAYLOAD",
    "MALFORMED_JSON",
    "UNAUTHORIZED",
    "AUTHENTICATION_REQUIRED",
    "INVALID_TOKEN",
    "INVALID_API_KEY",
    "INVALID_SIGNATURE",
    "INVALID_TIMESTAMP",
    "TIMESTAMP_OUT_OF_SKEW",
    "FORBIDDEN",
    "INSUFFICIENT_PERMISSIONS",
    "INVALID_ROLE",
    "RATE_LIMITED",
    "FEATURE_DISABLED",
    "IDEMPOTENCY_KEY_INVALID",
    "IDEMPOTENCY_IN_PROGRESS",
    "IDEMPOTENCY_KEY_MISMATCH",
    "REPLAY_DETECTED",
    "UNSUPPORTED_MEDIA_TYPE",
    "NOT_ACCEPTABLE",
    "NOT_FOUND",
    "CONFLICT",
    "UNPROCESSABLE_ENTITY",
  ];
  return publicCodes.includes(error.code as PublicErrorCode);
}

/**
 * Type guard: check if error is an internal error.
 */
export function isInternalError(error: ErrorType): error is InternalError {
  return !isPublicError(error);
}

/**
 * Taxonomy singleton: statically defined error entries with i18n keys.
 * Each entry validates the code → status → messageKey relationship.
 */
export const ERROR_TAXONOMY: Record<ErrorCode, ErrorType> = {
  // --- Validation (400 / 422) ---
  BAD_REQUEST: { code: "BAD_REQUEST", status: 400, messageKey: createMessageKey("errors.validation.bad_request") },
  VALIDATION_ERROR: { code: "VALIDATION_ERROR", status: 422, messageKey: createMessageKey("errors.validation.validation_error") },
  MISSING_REQUIRED_FIELD: { code: "MISSING_REQUIRED_FIELD", status: 400, messageKey: createMessageKey("errors.validation.missing_required_field") },
  INVALID_PAYLOAD: { code: "INVALID_PAYLOAD", status: 400, messageKey: createMessageKey("errors.validation.invalid_payload") },
  MALFORMED_JSON: { code: "MALFORMED_JSON", status: 400, messageKey: createMessageKey("errors.validation.malformed_json") },

  // --- Authentication (401) ---
  UNAUTHORIZED: { code: "UNAUTHORIZED", status: 401, messageKey: createMessageKey("errors.auth.unauthorized") },
  AUTHENTICATION_REQUIRED: { code: "AUTHENTICATION_REQUIRED", status: 401, messageKey: createMessageKey("errors.auth.authentication_required") },
  INVALID_TOKEN: { code: "INVALID_TOKEN", status: 401, messageKey: createMessageKey("errors.auth.invalid_token") },
  INVALID_API_KEY: { code: "INVALID_API_KEY", status: 401, messageKey: createMessageKey("errors.auth.invalid_api_key") },
  INVALID_SIGNATURE: { code: "INVALID_SIGNATURE", status: 401, messageKey: createMessageKey("errors.auth.invalid_signature") },
  INVALID_TIMESTAMP: { code: "INVALID_TIMESTAMP", status: 401, messageKey: createMessageKey("errors.auth.invalid_timestamp") },
  TIMESTAMP_OUT_OF_SKEW: { code: "TIMESTAMP_OUT_OF_SKEW", status: 401, messageKey: createMessageKey("errors.auth.timestamp_out_of_skew") },

  // --- Authorization (403) ---
  FORBIDDEN: { code: "FORBIDDEN", status: 403, messageKey: createMessageKey("errors.authz.forbidden") },
  INSUFFICIENT_PERMISSIONS: { code: "INSUFFICIENT_PERMISSIONS", status: 403, messageKey: createMessageKey("errors.authz.insufficient_permissions") },
  INVALID_ROLE: { code: "INVALID_ROLE", status: 400, messageKey: createMessageKey("errors.authz.invalid_role") },

  // --- Rate limiting (429) ---
  RATE_LIMITED: { code: "RATE_LIMITED", status: 429, messageKey: createMessageKey("errors.ratelimit.rate_limited") },

  // --- Feature flags (503) ---
  FEATURE_DISABLED: { code: "FEATURE_DISABLED", status: 503, messageKey: createMessageKey("errors.feature.feature_disabled") },

  // --- Idempotency / replay (400 / 409 / 422) ---
  IDEMPOTENCY_KEY_INVALID: { code: "IDEMPOTENCY_KEY_INVALID", status: 400, messageKey: createMessageKey("errors.idempotency.key_invalid") },
  IDEMPOTENCY_IN_PROGRESS: { code: "IDEMPOTENCY_IN_PROGRESS", status: 409, messageKey: createMessageKey("errors.idempotency.in_progress") },
  IDEMPOTENCY_KEY_MISMATCH: { code: "IDEMPOTENCY_KEY_MISMATCH", status: 422, messageKey: createMessageKey("errors.idempotency.key_mismatch") },
  REPLAY_DETECTED: { code: "REPLAY_DETECTED", status: 409, messageKey: createMessageKey("errors.idempotency.replay_detected") },

  // --- Content negotiation (406 / 415) ---
  UNSUPPORTED_MEDIA_TYPE: { code: "UNSUPPORTED_MEDIA_TYPE", status: 415, messageKey: createMessageKey("errors.content.unsupported_media_type") },
  NOT_ACCEPTABLE: { code: "NOT_ACCEPTABLE", status: 406, messageKey: createMessageKey("errors.content.not_acceptable") },

  // --- State / lifecycle (404 / 409 / 422) ---
  NOT_FOUND: { code: "NOT_FOUND", status: 404, messageKey: createMessageKey("errors.resource.not_found") },
  CONFLICT: { code: "CONFLICT", status: 409, messageKey: createMessageKey("errors.resource.conflict") },
  UNPROCESSABLE_ENTITY: { code: "UNPROCESSABLE_ENTITY", status: 422, messageKey: createMessageKey("errors.resource.unprocessable_entity") },

  // --- Infrastructure (500 / 503) ---
  DB_ERROR: { code: "DB_ERROR", status: 500, messageKey: createMessageKey("errors.internal.db_error") },
  INTERNAL_ERROR: { code: "INTERNAL_ERROR", status: 500, messageKey: createMessageKey("errors.internal.internal_error") },
  SERVICE_UNAVAILABLE: { code: "SERVICE_UNAVAILABLE", status: 503, messageKey: createMessageKey("errors.internal.service_unavailable") },
  CONFIGURATION_ERROR: { code: "CONFIGURATION_ERROR", status: 503, messageKey: createMessageKey("errors.internal.configuration_error") },
  FEATURE_FLAG_EVALUATION_ERROR: { code: "FEATURE_FLAG_EVALUATION_ERROR", status: 500, messageKey: createMessageKey("errors.internal.feature_flag_evaluation_error") },
} as const;

/**
 * Backward-compatibility export mapping old ERROR_CODES shape to new taxonomy.
 * Use ERROR_TAXONOMY for new code; this is maintained for gradual migration.
 */
export const ERROR_CODES = ERROR_TAXONOMY as Record<
  ErrorCode,
  { status: number; code: string }
>;
