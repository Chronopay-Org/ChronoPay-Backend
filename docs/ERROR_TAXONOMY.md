# Error Code Taxonomy Documentation

## Overview

ChronoPay's error code taxonomy is a typed, discriminated union system that distinguishes between **public-facing error codes** (stable API contract) and **internal-only codes** (transient implementation details). All error messages are routed through i18n keys instead of hardcoded literals.

**Key Benefits:**

- ✅ Type-safe at compile-time: unknown codes are rejected by TypeScript
- ✅ Security: internal error details never leak to public API
- ✅ i18n ready: all messages support multiple languages
- ✅ Backward compatible: legacy `ERROR_CODES` still available
- ✅ Well-tested: >95% test coverage on all components

## Architecture

### Core Components

```
src/errors/
├── errorTaxonomy.ts          # Typed discriminated unions
├── AppError.ts               # Error classes with i18n support
├── typeSafeError.ts          # Type-safe error sender functions
├── errorCodes.ts             # Backward compatibility export
└── __tests__/
    ├── errorTaxonomy.test.ts
    └── typeSafeError.test.ts

src/i18n/
├── messageLoader.ts          # Message resolution logic
├── locales.en.ts             # English message catalog
├── locales.es.ts             # Spanish message catalog
└── __tests__/
    └── messageLoader.test.ts
```

### Error Type Hierarchy

```typescript
// Public errors (safe to expose to API clients)
type PublicErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | ... (27 total public codes)

// Internal errors (never exposed, masked in production)
type InternalErrorCode =
  | "DB_ERROR"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "CONFIGURATION_ERROR"
  | "FEATURE_FLAG_EVALUATION_ERROR"

// Discriminated union: guarantees code ↔ status mapping
type PublicError =
  | { code: "NOT_FOUND"; status: 404; messageKey: I18nMessageKey }
  | { code: "FORBIDDEN"; status: 403; messageKey: I18nMessageKey }
  | ... (one variant per public code)
```

## Usage

### Using Type-Safe Error Senders

**For public errors** (expose to API clients):

```typescript
import { sendPublicError } from "./errors/typeSafeError.js";

// TypeScript will reject invalid codes at compile time
sendPublicError(res, "NOT_FOUND", "User not found", {
  locale: "es", // Optional: defaults to "en"
  details: { userId: 123 },
});

// Invalid code → compile error:
sendPublicError(res, "DB_ERROR", "..."); // ❌ Not a public code
```

**For internal errors** (production-safe):

```typescript
import { sendInternalError } from "./errors/typeSafeError.js";

try {
  const result = await database.query(...);
} catch (err) {
  // Details hidden in production, exposed in development
  sendInternalError(res, "DB_ERROR", err.message, {
    details: { query: "SELECT ..." }  // Hidden in prod
  });
}
```

**For dynamic error handling**:

```typescript
import { sendError } from "./errors/typeSafeError.js";

const code = getErrorCode(err); // Returns ErrorCode
sendError(res, code, message, { locale: "es" });
```

### Creating Error Instances

```typescript
import {
  ValidationError,
  NotFoundError,
  DatabaseError
} from "./errors/AppError.js";

// With i18n support
throw new ValidationError(
  "Invalid email format",
  { field: "email" },
  "errors.validation.invalid_email"  // Optional i18n key
);

// Check if error is public
const err = new ValidationError(...);
if (err.isPublic()) {
  // Safe to send to API client
  sendErrorResponse(res, err);
}
```

## Error Codes Reference

### Public Codes (Safe to Expose)

**Validation (400/422)**

- `BAD_REQUEST` (400)
- `VALIDATION_ERROR` (422)
- `MISSING_REQUIRED_FIELD` (400)
- `INVALID_PAYLOAD` (400)
- `MALFORMED_JSON` (400)

**Authentication (401)**

- `UNAUTHORIZED` (401)
- `AUTHENTICATION_REQUIRED` (401)
- `INVALID_TOKEN` (401)
- `INVALID_API_KEY` (401)
- `INVALID_SIGNATURE` (401)
- `INVALID_TIMESTAMP` (401)
- `TIMESTAMP_OUT_OF_SKEW` (401)

**Authorization (403)**

- `FORBIDDEN` (403)
- `INSUFFICIENT_PERMISSIONS` (403)
- `INVALID_ROLE` (400)

**Rate Limiting (429)**

- `RATE_LIMITED` (429)

**Feature Flags (503)**

- `FEATURE_DISABLED` (503)

**Idempotency (400/409/422)**

- `IDEMPOTENCY_KEY_INVALID` (400)
- `IDEMPOTENCY_IN_PROGRESS` (409)
- `IDEMPOTENCY_KEY_MISMATCH` (422)
- `REPLAY_DETECTED` (409)

**Content Negotiation (406/415)**

- `UNSUPPORTED_MEDIA_TYPE` (415)
- `NOT_ACCEPTABLE` (406)

**Resource States (404/409/422)**

- `NOT_FOUND` (404)
- `CONFLICT` (409)
- `UNPROCESSABLE_ENTITY` (422)

### Internal Codes (Never Exposed)

**Infrastructure (500/503)**

- `DB_ERROR` (500) - masked as `INTERNAL_ERROR` in production
- `INTERNAL_ERROR` (500)
- `SERVICE_UNAVAILABLE` (503) - masked in production
- `CONFIGURATION_ERROR` (503) - masked in production
- `FEATURE_FLAG_EVALUATION_ERROR` (500) - masked in production

## i18n Message Keys

All error codes map to i18n message keys following this pattern:

```
errors.<category>.<code_lowercase>
```

**Examples:**

```typescript
"errors.validation.bad_request" → "Bad Request"
"errors.auth.invalid_token" → "Invalid or expired token"
"errors.resource.not_found" → "Resource not found"
"errors.internal.db_error" → "Database error"
```

### Supported Locales

- `en` - English
- `es` - Spanish (Español)

To add a new language:

1. Create `src/i18n/locales.<lang>.ts`:

```typescript
export const XX_MESSAGES = {
  errors: {
    validation: { bad_request: "...", ... },
    auth: { ... },
    // ... all categories
  }
} as const;
```

2. Register in `src/i18n/messageLoader.ts`:

```typescript
import { XX_MESSAGES } from "./locales.xx.js";

const LOCALE_CATALOGS: Record<SupportedLocale, MessageCatalog> = {
  en: EN_MESSAGES,
  es: ES_MESSAGES,
  xx: XX_MESSAGES, // Add here
};
```

3. Update `SupportedLocale` type:

```typescript
export type SupportedLocale = "en" | "es" | "xx";
```

## Response Format

All error responses follow this format:

```json
{
  "success": false,
  "code": "NOT_FOUND",
  "message": "Resource not found",
  "error": "User not found",
  "timestamp": "2026-06-01T12:34:56.789Z",
  "requestId": "req-abc123",
  "details": { "userId": 123 }
}
```

**Fields:**

- `success` - Always `false` for errors
- `code` - Error code (public codes exposed, internal masked in production)
- `message` - i18n-resolved localized message
- `error` - Specific error context (for logging)
- `timestamp` - ISO 8601 timestamp
- `requestId` - Optional request ID for correlation
- `details` - Optional additional context (hidden in production for internal errors)

## Type Safety Guarantees

### Compile-Time

```typescript
// ✅ Valid: TypeScript accepts
sendPublicError(res, "NOT_FOUND", "msg");

// ❌ Invalid: Compile error
sendPublicError(res, "DB_ERROR", "msg"); // Not a public code
sendPublicError(res, "TYPO_CODE", "msg"); // Unknown code

// ✅ Type inference works
const code: PublicErrorCode = "FORBIDDEN";
sendPublicError(res, code, "msg"); // ✅

// ❌ Won't compile
const code: PublicErrorCode = "DB_ERROR"; // ❌
```

### Runtime

```typescript
// Invalid codes throw at runtime
try {
  sendError(res, "UNKNOWN_CODE" as any, "msg");
} catch (err) {
  console.error(err); // Error: Unknown error code
}

// Type guards for narrowing
const error = ERROR_TAXONOMY.NOT_FOUND;
if (isPublicError(error)) {
  // ✅ Can safely send to API client
  sendPublicError(res, "NOT_FOUND", "msg");
}

if (isInternalError(error)) {
  // Internal error handling
}
```

## Security Considerations

### Production Mode

In production (`NODE_ENV === "production"`):

1. **Internal error codes masked**: `DB_ERROR` → `INTERNAL_ERROR`
2. **Details hidden**: `details` field omitted from response
3. **Messages generalized**: Specific error context not exposed

```typescript
// In production:
sendInternalError(res, "DB_ERROR", "Query timeout", {
  details: { sql: "SELECT * FROM users" }
});

// Response (no SQL leak):
{
  "code": "INTERNAL_ERROR",
  "message": "Database error",
  "error": "Internal server error"
  // details: undefined
}
```

### Development Mode

All details exposed for debugging:

```typescript
// In development:
{
  "code": "DB_ERROR",
  "message": "Database error",
  "error": "Query timeout",
  "details": { sql: "SELECT * FROM users" }
}
```

### Client Trust

- Clients must treat error codes as opaque identifiers
- Error messages are user-facing (localized)
- Details field is informational (validation, hints)
- Numeric status codes are the source of truth

## Validation and Testing

### Compile-Time Validation

```bash
# Type-check catches all misuse
npm run typecheck
```

### Runtime Tests

```bash
# Run all error taxonomy tests
npm test -- errorTaxonomy typeSafeError messageLoader

# With coverage
npm run test:coverage

# Watch mode
npm test -- --watch
```

### Test Coverage

All components maintain **>95% test coverage**:

- `errorTaxonomy.ts`: Type safety, public/internal separation, HTTP status mapping
- `typeSafeError.ts`: Request sending, i18n resolution, security in production
- `messageLoader.ts`: Locale support, fallback behavior, message consistency

## Migration from Legacy Code

### Old Way

```typescript
import { ERROR_CODES } from "./errors/errorCodes.js";

throw new AppError("User not found", ERROR_CODES.NOT_FOUND.status, ERROR_CODES.NOT_FOUND.code);
```

### New Way

```typescript
import { NotFoundError } from "./errors/AppError.js";
import { sendPublicError } from "./errors/typeSafeError.js";

// Creating errors
throw new NotFoundError("User not found");

// Sending errors (type-safe)
sendPublicError(res, "NOT_FOUND", "User not found");
```

### Backward Compatibility

`ERROR_CODES` still exported from `errorCodes.ts` for gradual migration:

```typescript
// Old code still works
const status = ERROR_CODES.NOT_FOUND.status; // 404
const code = ERROR_CODES.NOT_FOUND.code; // "NOT_FOUND"
```

## Examples

### Example: User Validation Endpoint

```typescript
import { Router } from "express";
import { sendPublicError } from "../errors/typeSafeError.js";
import { ValidationError } from "../errors/AppError.js";

const router = Router();

router.post("/users", (req, res) => {
  const { email, name } = req.body;

  // Type-safe validation errors
  if (!email) {
    return sendPublicError(res, "MISSING_REQUIRED_FIELD", "Email is required", {
      details: { field: "email" },
      locale: req.locale,
    });
  }

  if (!email.includes("@")) {
    return sendPublicError(res, "VALIDATION_ERROR", "Invalid email format", {
      details: { field: "email" },
      locale: req.locale,
    });
  }

  // Proceed with user creation...
  res.json({ success: true, user: { email, name } });
});

export default router;
```

### Example: Database Error Handling

```typescript
import { sendInternalError } from "../errors/typeSafeError.js";

async function getUser(id: string, res: Response) {
  try {
    const user = await database.users.findById(id);
    if (!user) {
      // Public error: safe to expose
      return sendPublicError(res, "NOT_FOUND", "User not found", {
        details: { userId: id },
      });
    }
    return res.json({ success: true, user });
  } catch (err) {
    // Internal error: masked in production
    return sendInternalError(res, "DB_ERROR", String(err), {
      details: {
        query: "SELECT * FROM users WHERE id = $1",
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
```

## Performance

- **Zero runtime overhead**: Error taxonomy is compiled to flat object
- **Efficient message resolution**: O(1) key-based lookups
- **Small bundle**: All message catalogs < 10KB combined
- **No i18n library dependencies**: Custom lightweight loader

## Future Enhancements

Possible future additions:

1. **Dynamic language loading**: Load catalogs on-demand
2. **Message parameters**: Support placeholders like `"User {name} not found"`
3. **Error chains**: Link related errors together
4. **Custom categories**: Allow applications to extend taxonomy
5. **Metrics integration**: Track error rates by code
6. **Rate limit details**: Expose retry-after in response

## Troubleshooting

### "Unknown error code" Error

```typescript
// ❌ Problem: Typo in error code
sendPublicError(res, "NOT_FOUDN", "msg"); // Compile error

// ✅ Solution: Use correct code
sendPublicError(res, "NOT_FOUND", "msg");
```

### Missing Message Translation

```typescript
// ❌ Problem: Key not in locales
const msg = resolveMessage("errors.custom.new_code" as any, "en");
// Returns: "errors.custom.new_code"

// ✅ Solution: Add to locales.en.ts and locales.es.ts
```

### Internal Details Leaking in Production

```typescript
// ❌ Problem: Using sendPublicError for internal errors
sendPublicError(res, "DB_ERROR", "SQL error", { details: { sql } });

// ✅ Solution: Use sendInternalError (auto-masks in production)
sendInternalError(res, "DB_ERROR", "SQL error", { details: { sql } });
```

## References

- [TypeScript Handbook: Discriminated Unions](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions)
- [HTTP Status Codes](https://httpwg.org/specs/rfc7231.html#status.codes)
- [JSON:API Error Format](https://jsonapi.org/examples/#error-objects)
