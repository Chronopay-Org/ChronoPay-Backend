# Content Negotiation Guards

## Overview

ChronoPay API enforces consistent handling of `Content-Type` and `Accept` headers for JSON endpoints. This ensures all API interactions use proper JSON formatting and prevents content-type confusion attacks.

## Changes Made

### Files Created:
- `src/middleware/contentNegotiation.ts` - Core middleware implementation
- `src/__tests__/contentNegotiation.test.ts` - 30 comprehensive tests
- `docs/api/content-negotiation.md` - This documentation

### Files Modified:
- `src/errors/AppError.ts` - Added `ContentNegotiationError` class
- `src/middleware/errorHandling.ts` - Updated to handle 415/406 error envelopes
- `src/app.ts` - Wired middleware + added Content-Type response header + updated `AppFactoryOptions`
- `src/index.ts` - Cleaned up to properly use `createApp()` from `src/app.ts`
- `jest.config.cjs` - Fixed module mapper for Jest tests

## Behavior Matrix

| HTTP Method | Content-Type Check | Accept Check | Notes |
|-------------|-------------------|--------------|-------|
| GET | Skip | Skip | Read operation, no request body |
| POST | Enforced (must be `application/json`) | Enforced | Create operation |
| PUT | Enforced (must be `application/json`) | Enforced | Update operation |
| PATCH | Enforced (must be `application/json`) | Enforced | Partial update |
| DELETE | Skip | Skip | Delete operation, no request body |
| OPTIONS | Skip | Skip | CORS preflight bypass |
| HEAD | Skip | Skip | Same as GET |

## Content-Type Validation

**Enforced on:** POST, PUT, PATCH

**Valid values:**
- `application/json`
- `application/json; charset=utf-8` (charset is ignored)
- `application/json; charset=UTF-8` (case-insensitive charset)

**Invalid values:**
- `text/plain`
- `application/xml`
- `multipart/form-data`
- Any other media type
- Missing Content-Type header

**Implementation note:** Uses `content-type` header split by `;` and trimmed to extract media type. Charset parameter is stripped before validation.

## Accept Header Validation

**Enforced on:** POST, PUT, PATCH (not on GET, DELETE, OPTIONS, HEAD)

**Valid values:**
- `application/json`
- `*/*` (wildcard, accepts any content type)
- `application/json; q=0.8, text/html; q=0.2` (quality values supported)
- Missing Accept header (treated as accepting everything)

**Invalid values:**
- `text/html`
- `application/xml`
- Any header that doesn't include `application/json` or `*/*`

## Error Responses

### 415 Unsupported Media Type

Returned when `Content-Type` header is missing or not `application/json` on POST/PUT/PATCH requests.

**Response format:**
```json
{
  "success": false,
  "code": "UNSUPPORTED_MEDIA_TYPE",
  "error": "Content-Type must be application/json"
}
```

**Example:**
```bash
curl -X POST http://localhost:3001/api/v1/slots \
  -H "Content-Type: text/plain" \
  -d "test" \
  -i
```

Returns:
```
HTTP/1.1 415 Unsupported Media Type
Content-Type: application/json

{
  "success": false,
  "code": "UNSUPPORTED_MEDIA_TYPE",
  "error": "Content-Type must be application/json"
}
```

### 406 Not Acceptable

Returned when `Accept` header doesn't include `application/json` or `*/*` on POST/PUT/PATCH requests.

**Response format:**
```json
{
  "success": false,
  "code": "NOT_ACCEPTABLE",
  "error": "Accept header must include application/json"
}
```

**Example:**
```bash
curl -X POST http://localhost:3001/api/v1/slots \
  -H "Content-Type: application/json" \
  -H "Accept: text/html" \
  -d '{"professional":"test","startTime":"2026-01-01","endTime":"2026-01-02"}' \
  -i
```

Returns:
```
HTTP/1.1 406 Not Acceptable
Content-Type: application/json

{
  "success": false,
  "code": "NOT_ACCEPTABLE",
  "error": "Accept header must include application/json"
}
```

## Webhook Exclusion

Certain endpoints (e.g., webhooks) may require non-JSON payloads. These can be excluded from content negotiation checks by configuring `contentNegotiationExcludePaths` in `AppFactoryOptions`:

```typescript
const app = createApp({
  enableContentNegotiation: true,
  contentNegotiationExcludePaths: [
    "/api/v1/webhooks",
    "/api/v1/checkout/webhook",
  ],
});
```

Excluded paths are matched by prefix - any path starting with an excluded prefix will skip content negotiation checks.

## Response Content-Type Header

All API responses include the `Content-Type: application/json` header, set globally via middleware in `src/app.ts`. This ensures clients can reliably parse responses.

**Implementation:** Added middleware in `src/app.ts` after route definitions but before error handlers:
```typescript
app.use((_req, res, next) => {
  res.setHeader('Content-Type', 'application/json');
  next();
});
```

## Configuration

### AppFactoryOptions

Updated `src/app.ts` to include new options:
```typescript
export interface AppFactoryOptions {
  apiKey?: string;
  enableDocs?: boolean;
  enableTestRoutes?: boolean;
  enableContentNegotiation?: boolean;        // NEW
  contentNegotiationExcludePaths?: string[]; // NEW
}
```

Content negotiation is enabled by default. To disable (e.g., for testing or migration):

```typescript
const app = createApp({
  enableContentNegotiation: false,
});
```

## Security Notes

1. **No header value leakage:** Error messages do not include the actual header values, preventing information disclosure.

2. **Charset handling:** The charset parameter is stripped before validation, preventing bypass attempts like `application/json; charset=" , application/json"`.

3. **CORS preflight:** OPTIONS requests are explicitly bypassed to avoid breaking CORS. The preflight will succeed and the actual request will be validated.

4. **Webhook bypass:** Path exclusions should be carefully reviewed. Only exclude paths that genuinely require non-JSON payloads (e.g., Stripe webhooks that use raw body parsing).

5. **Middleware order:** Content negotiation runs BEFORE `express.json()` middleware in `src/app.ts`. This ensures invalid Content-Type requests are rejected before body parsing, preventing potential issues with body parsers.

6. **Error propagation:** Uses `ContentNegotiationError` (extends `AppError`) passed to `next()`, handled by `genericErrorHandler` in `src/middleware/errorHandling.ts`.

## Architecture Changes

### Error Handling

Added `ContentNegotiationError` class to `src/errors/AppError.ts`:
```typescript
export class ContentNegotiationError extends AppError {
  constructor(
    statusCode: 415 | 406,
    code: string,
    message: string,
  ) {
    super(message, statusCode, code, true);
  }
}
```

Updated `genericErrorHandler` in `src/middleware/errorHandling.ts` to handle these errors:
```typescript
if (
  err instanceof Error &&
  "statusCode" in err &&
  "code" in err
) {
  const e = err as any;
  if (
    (e.statusCode === 415 || e.statusCode === 406) &&
    (e.code === "UNSUPPORTED_MEDIA_TYPE" || e.code === "NOT_ACCEPTABLE")
  ) {
    return res.status(e.statusCode).json({
      success: false,
      code: e.code,
      error: e.message,
    });
  }
}
```

### Entry Point Cleanup

Cleaned up `src/index.ts` to properly use `createApp()` from `src/app.ts`:
- Removed duplicated route definitions
- Removed undefined variable references
- Properly loads env config
- Starts scheduler and server using the created app

## Test Coverage

The implementation includes 30 comprehensive tests in `src/__tests__/contentNegotiation.test.ts` covering:

**Unit Tests (Content-Type Validation):**
- Accept `application/json` Content-Type on POST/PUT/PATCH
- Accept `application/json; charset=utf-8` with charset
- Reject non-JSON Content-Type (415)
- Reject missing Content-Type (415)

**Unit Tests (Accept Header Validation):**
- Accept `application/json` Accept header
- Accept `*/*` Accept header
- Accept missing Accept header
- Reject invalid Accept header (406)
- Reject complex invalid Accept header (406)

**Unit Tests (Method Skipping):**
- Skip Content-Type check on GET, DELETE
- Skip OPTIONS (CORS preflight)
- Skip Accept check on GET, DELETE

**Unit Tests (Path Exclusion):**
- Skip checks for excluded path exact match
- Skip checks for excluded path prefix match
- Enforce checks for non-excluded paths

**Integration Tests (with createApp()):**
- Reject POST with wrong Content-Type
- Accept POST with valid Content-Type
- Reject POST with invalid Accept header
- Set Content-Type response header
- Allow GET without Content-Type
- Accept POST with any Content-Type when disabled
- Skip checks for excluded paths

**Error Envelope Tests:**
- Return proper error envelope for 415
- Return proper error envelope for 406
- Not leak header values in error messages

**Test Results:** 30/30 tests passing (100% on new code).

## Implementation Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/middleware/contentNegotiation.ts` | Created | Core middleware implementation |
| `src/errors/AppError.ts` | Modified | Added `ContentNegotiationError` class |
| `src/middleware/errorHandling.ts` | Modified | Error envelope handling for 415/406 |
| `src/app.ts` | Modified | Middleware registration, Content-Type header, AppFactoryOptions |
| `src/index.ts` | Modified | Cleaned up to use createApp() properly |
| `src/__tests__/contentNegotiation.test.ts` | Created | 30 comprehensive tests |
| `jest.config.cjs` | Modified | Fixed module mapper for tests |
| `docs/api/content-negotiation.md` | Created | This documentation |
