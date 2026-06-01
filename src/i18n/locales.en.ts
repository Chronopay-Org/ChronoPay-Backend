/**
 * Localized error messages for English (en).
 * These map directly to i18n keys in errorTaxonomy.ts.
 */
export const EN_MESSAGES = {
  errors: {
    validation: {
      bad_request: "Bad Request",
      validation_error: "Validation failed",
      missing_required_field: "Missing required field",
      invalid_payload: "Invalid payload",
      malformed_json: "Malformed JSON payload",
    },
    auth: {
      unauthorized: "Unauthorized",
      authentication_required: "Authentication required",
      invalid_token: "Invalid or expired token",
      invalid_api_key: "Invalid API key",
      invalid_signature: "Invalid signature",
      invalid_timestamp: "Invalid timestamp",
      timestamp_out_of_skew: "Timestamp out of acceptable skew",
    },
    authz: {
      forbidden: "Forbidden",
      insufficient_permissions: "Insufficient permissions",
      invalid_role: "Invalid role",
    },
    ratelimit: {
      rate_limited: "Rate limit exceeded",
    },
    feature: {
      feature_disabled: "Feature is currently disabled",
    },
    idempotency: {
      key_invalid: "Invalid idempotency key",
      in_progress: "Request with this idempotency key is in progress",
      key_mismatch: "Idempotency key mismatch",
      replay_detected: "Replay detected",
    },
    content: {
      unsupported_media_type: "Unsupported media type",
      not_acceptable: "Not acceptable",
    },
    resource: {
      not_found: "Resource not found",
      conflict: "Conflict",
      unprocessable_entity: "Unprocessable entity",
    },
    internal: {
      db_error: "Database error",
      internal_error: "Internal server error",
      service_unavailable: "Service unavailable",
      configuration_error: "Configuration error",
      feature_flag_evaluation_error: "Feature flag evaluation error",
    },
  },
} as const;
