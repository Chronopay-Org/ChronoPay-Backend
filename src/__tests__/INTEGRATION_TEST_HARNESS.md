# ChronoPay Integration Test Harness

## Scope

- This harness is scoped to backend HTTP integration behavior in `src`.
- It exercises app bootstrapping, middleware, route handlers, and error paths together.

## Harness Design

- `helpers/integrationHarness.ts` creates a fully wired app via `createApp`.
- Test-only routes are enabled to validate 500-series failure handling without exposing those routes in production.
- API docs registration is disabled in harness mode to reduce test flakiness and external dependency requirements.

## Acceptance Criteria

- Health endpoint responds with service readiness contract.
- Slot creation succeeds with valid payload and valid API key.
- Missing or invalid API key is rejected with 401/403.
- Missing required fields return 400.
- Semantically invalid time data returns 422.
- Malformed JSON returns 400.
- Unknown routes return structured 404 JSON.
- Unexpected server faults return sanitized 500 JSON without internal details.

## Failure-Mode Handling Matrix

- Missing auth header: `401 Missing API key`.
- Wrong auth header: `403 Invalid API key`.
- Missing required fields: `400 Missing required field`.
- Malformed JSON body: `400 Malformed JSON payload`.
- Invalid business rule (`endTime <= startTime`): `422`.
- Unknown route: `404 Route not found`.
- Unhandled exception: `500 Internal server error`.

## Security Notes

- API key gate is opt-in via app config (`CHRONOPAY_API_KEY` in runtime).
- Error handlers intentionally avoid leaking stack traces or implementation details in API responses.
- JSON body size limit is set to `100kb` to reduce abuse risk.
