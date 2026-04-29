# Error Code Taxonomy

ChronoPay API error responses use a single canonical envelope. Every error
response — whether produced by middleware, a route handler, or the global
error handler — emits the same shape, and every error carries a stable
machine-readable `code`.

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

| Code                       | Status | When emitted                                              |
| -------------------------- | ------ | --------------------------------------------------------- |
| `BAD_REQUEST`              | 400    | Generic malformed request.                                |
| `MISSING_REQUIRED_FIELD`   | 400    | Required body/query/param field is missing or empty.      |
| `INVALID_PAYLOAD`          | 400    | Payload structurally invalid (wrong type, shape).         |
| `MALFORMED_JSON`           | 400    | Request body is not valid JSON.                           |
| `VALIDATION_ERROR`         | 422    | Semantic validation failure (e.g., business rule).        |

### Authentication (401)

| Code                      | Status | When emitted                                              |
| ------------------------- | ------ | --------------------------------------------------------- |
| `UNAUTHORIZED`            | 401    | Generic authentication failure.                           |
| `AUTHENTICATION_REQUIRED` | 401    | Required auth header/token absent.                        |
| `INVALID_TOKEN`           | 401    | Bearer token malformed, expired, or rejected.             |
| `INVALID_API_KEY`         | 401    | API key missing or does not match expected.               |
| `INVALID_SIGNATURE`       | 401    | HMAC signature verification failed.                       |
| `INVALID_TIMESTAMP`       | 401    | HMAC timestamp header is not a finite number.             |
| `TIMESTAMP_OUT_OF_SKEW`   | 401    | HMAC timestamp outside the allowed skew window.           |

### Authorization (400 / 403)

| Code                       | Status | When emitted                                              |
| -------------------------- | ------ | --------------------------------------------------------- |
| `FORBIDDEN`                | 403    | Generic authorization failure.                            |
| `INSUFFICIENT_PERMISSIONS` | 403    | Authenticated principal lacks the required role.          |
| `INVALID_ROLE`             | 400    | Role header present but value is not recognized.          |

### Rate limiting (429)

| Code           | Status | When emitted                                              |
| -------------- | ------ | --------------------------------------------------------- |
| `RATE_LIMITED` | 429    | Caller exceeded the configured request ceiling.           |

### Feature flags (500 / 503)

| Code                            | Status | When emitted                                          |
| ------------------------------- | ------ | ----------------------------------------------------- |
| `FEATURE_DISABLED`              | 503    | Route guarded behind a flag that is currently off.    |
| `FEATURE_FLAG_EVALUATION_ERROR` | 500    | Flag accessor threw while evaluating the flag.        |

### Idempotency / replay (400 / 409 / 422)

| Code                       | Status | When emitted                                              |
| -------------------------- | ------ | --------------------------------------------------------- |
| `IDEMPOTENCY_KEY_INVALID`  | 400    | `Idempotency-Key` header malformed.                       |
| `IDEMPOTENCY_IN_PROGRESS`  | 409    | Another request with the same key is still running.       |
| `IDEMPOTENCY_KEY_MISMATCH` | 422    | Same key reused with a different request payload.         |
| `REPLAY_DETECTED`          | 409    | HMAC replay window detected an already-seen signature.    |

### Content negotiation (406 / 415)

| Code                     | Status | When emitted                                              |
| ------------------------ | ------ | --------------------------------------------------------- |
| `UNSUPPORTED_MEDIA_TYPE` | 415    | Request `Content-Type` is not `application/json`.         |
| `NOT_ACCEPTABLE`         | 406    | Request `Accept` does not include JSON.                   |

### State / lifecycle (404 / 409 / 422)

| Code                    | Status | When emitted                                               |
| ----------------------- | ------ | ---------------------------------------------------------- |
| `NOT_FOUND`             | 404    | Requested resource or route does not exist.                |
| `CONFLICT`              | 409    | Request conflicts with current resource state.             |
| `UNPROCESSABLE_ENTITY`  | 422    | Request was valid but cannot be processed in current state.|

### Infrastructure (500 / 503)

| Code                  | Status | When emitted                                                  |
| --------------------- | ------ | ------------------------------------------------------------- |
| `INTERNAL_ERROR`      | 500    | Unhandled error or unknown exception.                         |
| `DB_ERROR`            | 500    | Database driver, query, or transaction failure.               |
| `SERVICE_UNAVAILABLE` | 503    | Dependency unavailable; safe to retry.                        |
| `CONFIGURATION_ERROR` | 503    | Required configuration (secret, feature, env) is missing.     |

## Examples

**Validation — missing field**

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "success": false,
  "code": "MISSING_REQUIRED_FIELD",
  "error": "Missing required field: startTime",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "details": { "field": "startTime" }
}
```

**Authorization — insufficient permissions**

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{
  "success": false,
  "code": "INSUFFICIENT_PERMISSIONS",
  "error": "Insufficient permissions",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "requestId": "req_abc123"
}
```

**Idempotency — payload mismatch**

```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json

{
  "success": false,
  "code": "IDEMPOTENCY_KEY_MISMATCH",
  "error": "Unprocessable Entity: Idempotency-Key used with different payload.",
  "timestamp": "2026-04-26T12:34:56.789Z"
}
```

## Adding a new code

1. Add the entry to `src/errors/errorCodes.ts` (`ERROR_CODES` map). This is
   the single source of truth.
2. If a new HTTP semantic is involved, add an `AppError` subclass in
   `src/errors/AppError.ts` so middleware/route code can throw it directly.
3. Update the relevant section of this document.
4. Add a test asserting the code propagates through the global handler.

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
