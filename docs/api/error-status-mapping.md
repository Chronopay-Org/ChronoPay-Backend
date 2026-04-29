# Domain Error to HTTP Status Mapping

This document defines the mapping between ChronoPay domain/service errors and HTTP status codes, and how these are enforced in the centralized error handler.

## Purpose
To ensure consistent, predictable, and secure error responses across all API modules.

## Mapping Table
| Domain Error Type         | HTTP Status | Description                        |
|--------------------------|-------------|------------------------------------|
| ValidationError          | 400         | Invalid input                      |
| AuthenticationError      | 401         | Authentication required/failed     |
| AuthorizationError       | 403         | Forbidden                          |
| NotFoundError            | 404         | Resource not found                 |
| ConflictError            | 409         | Resource conflict                  |
| UnprocessableEntityError | 422         | Semantic/validation error          |
| RateLimitError           | 429         | Too many requests                  |
| FeatureDisabledError     | 503         | Feature/service unavailable        |
| InternalError/Other      | 500         | Internal server error (sanitized)  |

## Enforcement
- The error handler in `src/middleware/errorHandler.ts` uses this mapping.
- Internal errors are always sanitized and mapped to 500.
- All error responses include a stable structure and never leak stack traces in production.

## Example
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Resource not found",
    "requestId": "..."
  }
}
```

## Security Notes
- Internal errors are never exposed to clients.
- All error codes and messages are reviewed for information leakage.

## Testing
- All mappings are covered by automated tests.
- Edge cases (conflict, feature disabled, etc.) are tested.
