# Error Code Taxonomy

ChronoPay API error responses use a single canonical envelope. Every error
response — whether produced by middleware, a route handler, or the global
error handler — emits the same shape, and every error carries a stable
machine-readable `code`.

This document is **generated** from `src/errors/errorCodes.ts`
(`npm run generate:error-docs`). Do not edit the code tables by hand.

## Envelope

```json
{
  "success": false,
  "code": "ERROR_CODE",
  "error": "Human-readable explanation.",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "requestId": "req_abc123",
  "details": { /* optional, code-specific */ }
}
```

| Field       | Type    | Required | Notes                                                  |
| ----------- | ------- | -------- | ------------------------------------------------------ |
| `success`   | boolean | yes      | Always `false` for error responses.                    |
| `code`      | string  | yes      | Stable identifier from the table below.                |
| `error`     | string  | yes      | Human-readable, safe to surface to end users.          |
| `timestamp` | string  | yes      | ISO 8601 UTC timestamp.                                |
| `requestId` | string  | when set | Correlates with logs; absent if no request id is set.  |
| `details`   | object  | no       | Optional, code-specific structured data.               |
| `stack`     | string  | dev only | Included only when `NODE_ENV !== "production"`.        |

Stack traces are NEVER included in production. Internal/unknown errors are
mapped to `INTERNAL_ERROR` with a generic message; the original cause is
written to logs but never returned over the wire.

## Codes

### Validation (400 / 422)

| Code                       | Status | Scope    | When emitted                                              |
| -------------------------- | ------ | -------- | --------------------------------------------------------- |
| `BAD_REQUEST               ` | 400   | public  | Generic malformed request. |
| `VALIDATION_ERROR          ` | 422   | public  | Semantic validation failure (e.g., business rule). |
| `MISSING_REQUIRED_FIELD    ` | 400   | public  | Required body/query/param field is missing or empty. |
| `INVALID_PAYLOAD           ` | 400   | public  | Payload structurally invalid (wrong type, shape). |
| `MALFORMED_JSON            ` | 400   | public  | Request body is not valid JSON. |

### Authentication (401)

| Code                       | Status | Scope    | When emitted                                              |
| -------------------------- | ------ | -------- | --------------------------------------------------------- |
| `UNAUTHORIZED              ` | 401   | public  | Generic authentication failure. |
| `AUTHENTICATION_REQUIRED   ` | 401   | public  | Required auth header/token absent. |
| `INVALID_TOKEN             ` | 401   | public  | Bearer token malformed, expired, or rejected. |
| `INVALID_API_KEY           ` | 401   | public  | API key missing or does not match expected. |
| `INVALID_SIGNATURE         ` | 401   | public  | HMAC signature verification failed. |
| `INVALID_TIMESTAMP         ` | 401   | public  | HMAC timestamp header is not a finite number. |
| `TIMESTAMP_OUT_OF_SKEW     ` | 401   | public  | HMAC timestamp outside the allowed skew window. |

### Authorization (400 / 403)

| Code                       | Status | Scope    | When emitted                                              |
| -------------------------- | ------ | -------- | --------------------------------------------------------- |
| `FORBIDDEN                 ` | 403   | public  | Generic authorization failure. |
| `INSUFFICIENT_PERMISSIONS  ` | 403   | public  | Authenticated principal lacks the required role. |
| `INVALID_ROLE              ` | 400   | public  | Role header present but value is not recognized. |

### Rate limiting (429)

| Code                       | Status | Scope    | When emitted                                              |
| -------------------------- | ------ | -------- | --------------------------------------------------------- |
| `RATE_LIMITED              ` | 429   | public  | Caller exceeded the configured request ceiling. |

### Feature flags (503)

| Code                       | Status | Scope    | When emitted                                              |
| -------------------------- | ------ | -------- | --------------------------------------------------------- |
| `FEATURE_DISABLED          ` | 503   | public  | Route guarded behind a flag that is currently off. |

### Idempotency / replay (400 / 409 / 422)

| Code                       | Status | Scope    | When emitted                                              |
| -------------------------- | ------ | -------- | --------------------------------------------------------- |
| `IDEMPOTENCY_KEY_INVALID   ` | 400   | public  | `Idempotency-Key` header malformed. |
| `IDEMPOTENCY_IN_PROGRESS   ` | 409   | public  | Another request with the same key is still running. |
| `IDEMPOTENCY_KEY_MISMATCH  ` | 422   | public  | Same key reused with a different request payload. |
| `REPLAY_DETECTED           ` | 409   | public  | HMAC replay window detected an already-seen signature. |

### Content negotiation (406 / 415)

| Code                       | Status | Scope    | When emitted                                              |
| -------------------------- | ------ | -------- | --------------------------------------------------------- |
| `UNSUPPORTED_MEDIA_TYPE    ` | 415   | public  | Request `Content-Type` is not `application/json`. |
| `NOT_ACCEPTABLE            ` | 406   | public  | Request `Accept` does not include JSON. |

### State / lifecycle (404 / 409 / 422)

| Code                       | Status | Scope    | When emitted                                              |
| -------------------------- | ------ | -------- | --------------------------------------------------------- |
| `NOT_FOUND                 ` | 404   | public  | Requested resource or route does not exist. |
| `CONFLICT                  ` | 409   | public  | Request conflicts with current resource state. |
| `UNPROCESSABLE_ENTITY      ` | 422   | public  | Request was valid but cannot be processed in current state. |

### Bundles (422)

| Code                       | Status | Scope    | When emitted                                              |
| -------------------------- | ------ | -------- | --------------------------------------------------------- |
| `BUNDLE_EXPIRED            ` | 422   | public  | Booking bundle has expired and can no longer be used. |
| `BUNDLE_NOT_TRANSFERABLE   ` | 422   | public  | Booking bundle cannot be transferred between bookings. |

### Query budget (503)

| Code                       | Status | Scope    | When emitted                                              |
| -------------------------- | ------ | -------- | --------------------------------------------------------- |
| `QUERY_BUDGET_EXCEEDED     ` | 503   | public  | Request consumed too much database time; retry later. |

### Infrastructure (500 / 503)

| Code                       | Status | Scope    | When emitted                                              |
| -------------------------- | ------ | -------- | --------------------------------------------------------- |
| `INTERNAL_ERROR            ` | 500   | internal | Unhandled error or unknown exception. |
| `DB_ERROR                  ` | 500   | internal | Database driver, query, or transaction failure. |
| `SERVICE_UNAVAILABLE       ` | 503   | internal | Dependency unavailable; safe to retry. |
| `CONFIGURATION_ERROR       ` | 503   | internal | Required configuration (secret, feature, env) is missing. |
| `FEATURE_FLAG_EVALUATION_ERROR` | 500   | internal | Flag accessor threw while evaluating the flag. |

## Adding a new code

1. Add the entry to `src/errors/errorCodes.ts` — the `ERROR_TAXONOMY` record
   is the single source of truth. Choosing `scope: "public"` makes it part of
   the stable API contract; `scope: "internal"` keeps it out of the public
   surface.
2. For a new i18n key, add localized messages in
   `src/i18n/locales.en.ts` and `src/i18n/locales.es.ts`.
3. Add an `AppError` subclass in `src/errors/AppError.ts` if a new HTTP
   semantic is involved so middleware/route code can throw it directly.
4. Run `npm run generate:error-docs` to regenerate this document.
5. Add a test asserting the code propagates through the global handler.

## Client integration

- Match on `code`, never on `error`. The human-readable string is allowed to
  change between releases for clarity; codes are part of the API contract.
- `code` is stable; once published, removing or repurposing one is a
  breaking change.
- Treat `5xx` codes as retryable; treat `4xx` (except `429`) as terminal
  unless the caller can correct the input. `429` and `503` should be
  retried with backoff.
- `requestId` (when present) is the correlation key for support / log
  lookups.
