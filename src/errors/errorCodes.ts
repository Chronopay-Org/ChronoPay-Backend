/**
 * Canonical ChronoPay API error code taxonomy.
 *
 * Every error response that exits the API surface MUST include one of the
 * codes defined here. Adding a new code is an API contract change — update
 * `docs/error-codes.md` whenever this map changes.
 */

export const ERROR_CODES = {
  // --- Validation (400 / 422) ---
  BAD_REQUEST: { status: 400, code: "BAD_REQUEST" },
  VALIDATION_ERROR: { status: 422, code: "VALIDATION_ERROR" },
  MISSING_REQUIRED_FIELD: { status: 400, code: "MISSING_REQUIRED_FIELD" },
  INVALID_PAYLOAD: { status: 400, code: "INVALID_PAYLOAD" },
  MALFORMED_JSON: { status: 400, code: "MALFORMED_JSON" },

  // --- Authentication (401) ---
  UNAUTHORIZED: { status: 401, code: "UNAUTHORIZED" },
  AUTHENTICATION_REQUIRED: { status: 401, code: "AUTHENTICATION_REQUIRED" },
  INVALID_TOKEN: { status: 401, code: "INVALID_TOKEN" },
  INVALID_API_KEY: { status: 401, code: "INVALID_API_KEY" },
  INVALID_SIGNATURE: { status: 401, code: "INVALID_SIGNATURE" },
  INVALID_TIMESTAMP: { status: 401, code: "INVALID_TIMESTAMP" },
  TIMESTAMP_OUT_OF_SKEW: { status: 401, code: "TIMESTAMP_OUT_OF_SKEW" },

  // --- Authorization (400 / 403) ---
  FORBIDDEN: { status: 403, code: "FORBIDDEN" },
  INSUFFICIENT_PERMISSIONS: { status: 403, code: "INSUFFICIENT_PERMISSIONS" },
  INVALID_ROLE: { status: 400, code: "INVALID_ROLE" },

  // --- Rate limiting (429) ---
  RATE_LIMITED: { status: 429, code: "RATE_LIMITED" },

  // --- Feature flags (500 / 503) ---
  FEATURE_DISABLED: { status: 503, code: "FEATURE_DISABLED" },
  FEATURE_FLAG_EVALUATION_ERROR: {
    status: 500,
    code: "FEATURE_FLAG_EVALUATION_ERROR",
  },

  // --- Idempotency / replay (400 / 409 / 422) ---
  IDEMPOTENCY_KEY_INVALID: { status: 400, code: "IDEMPOTENCY_KEY_INVALID" },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, code: "IDEMPOTENCY_IN_PROGRESS" },
  IDEMPOTENCY_KEY_MISMATCH: {
    status: 422,
    code: "IDEMPOTENCY_KEY_MISMATCH",
  },
  REPLAY_DETECTED: { status: 409, code: "REPLAY_DETECTED" },

  // --- Content negotiation (406 / 415) ---
  UNSUPPORTED_MEDIA_TYPE: { status: 415, code: "UNSUPPORTED_MEDIA_TYPE" },
  NOT_ACCEPTABLE: { status: 406, code: "NOT_ACCEPTABLE" },

  // --- State / lifecycle (404 / 409 / 422) ---
  NOT_FOUND: { status: 404, code: "NOT_FOUND" },
  CONFLICT: { status: 409, code: "CONFLICT" },
  UNPROCESSABLE_ENTITY: { status: 422, code: "UNPROCESSABLE_ENTITY" },

  // --- Infrastructure (500 / 503) ---
  INTERNAL_ERROR: { status: 500, code: "INTERNAL_ERROR" },
  DB_ERROR: { status: 500, code: "DB_ERROR" },
  SERVICE_UNAVAILABLE: { status: 503, code: "SERVICE_UNAVAILABLE" },
  CONFIGURATION_ERROR: { status: 503, code: "CONFIGURATION_ERROR" },
} as const;

export type ErrorCodeKey = keyof typeof ERROR_CODES;
export type ErrorCodeString = (typeof ERROR_CODES)[ErrorCodeKey]["code"];
