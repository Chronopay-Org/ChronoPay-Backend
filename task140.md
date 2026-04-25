# Task 140: Add Request Content Negotiation Middleware (Accept/Content-Type) for JSON APIs

## Full Plan — Content Negotiation Guards

### Phase 1: Research & Verification (30 min)

Read these files to capture exact patterns:
- `src/routes/checkout.ts` — identify webhook paths for exclusion list
- `src/middleware/errorHandler.ts` — capture error envelope shape (`{ success: false, error: ... }`)
- `src/app.ts` — inspect `AppFactoryOptions`, `createApp()` signature, middleware order
- `src/index.ts` — confirm entry point, check for duplicated route definitions
- `src/middleware/rateLimiter.ts` — copy export style and TypeScript patterns
- `src/utils/factories.ts` — reuse test factory patterns

---

### Phase 2: Create Error Class (15 min)

**File:** `src/errors/ContentNegotiationError.ts` (or add to existing `src/errors/AppError.ts`)

```typescript
export class ContentNegotiationError extends Error {
  constructor(
    public readonly statusCode: 415 | 406,
    public readonly code: string,
    public readonly message: string
  ) {
    super(message);
    this.name = "ContentNegotiationError";
  }
}
```

Two error types:
- `415` / `UNSUPPORTED_MEDIA_TYPE` — invalid Content-Type
- `406` / `NOT_ACCEPTABLE` — invalid Accept header

---

### Phase 3: Create Middleware (1-2 hours)

**File:** `src/middleware/contentNegotiation.ts`

**Behavior specification:**

| Method | Content-Type Check | Accept Check |
|--------|-------------------|--------------|
| GET, DELETE, HEAD | Skip | Skip |
| OPTIONS | Skip (CORS preflight) | Skip |
| POST, PUT, PATCH | Enforce `application/json` (ignore charset) | Enforce `application/json` or `*/*` |

**Exclusion:** Accept `excludePaths: string[]` config — match `req.path.startsWith(path)` for webhook routes.

**Charset handling:** `const contentType = (req.headers['content-type'] || '').split(';')[0].trim()`

**Logic flow:**
1. If `req.method === 'OPTIONS'` → `return next()`
2. If `excludePaths.some(p => req.path.startsWith(p))` → `return next()`
3. If POST/PUT/PATCH and invalid Content-Type → `return next(new ContentNegotiationError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'))`
4. If POST/PUT/PATCH and Accept header exists but doesn't include `application/json` or `*/*` → `return next(new ContentNegotiationError(406, 'NOT_ACCEPTABLE', 'Accept header must include application/json'))`
5. Otherwise → `return next()`

**Export:** `export function createContentNegotiationMiddleware(options?: { excludePaths?: string[] })`

---

### Phase 4: Update Error Handler (30 min)

**File:** `src/middleware/errorHandler.ts`

Add case to detect `ContentNegotiationError`:

```typescript
if (err instanceof ContentNegotiationError) {
  res.status(err.statusCode).json({
    success: false,
    code: err.code,
    error: err.message,
  });
  return;
}
```

Place before generic error handler. Ensure no raw header values leak into error messages.

---

### Phase 5: Wire Into App (30 min)

**File:** `src/app.ts`

Update `AppFactoryOptions`:
```typescript
export interface AppFactoryOptions {
  apiKey?: string;
  enableDocs?: boolean;
  enableTestRoutes?: boolean;
  enableContentNegotiation?: boolean; // NEW
  contentNegotiationExcludePaths?: string[]; // NEW
}
```

Inside `createApp()`, middleware order:
```typescript
app.use(cors());
// Content negotiation BEFORE express.json()
if (options.enableContentNegotiation !== false) {
  app.use(createContentNegotiationMiddleware({
    excludePaths: options.contentNegotiationExcludePaths,
  }));
}
app.use(express.json({ limit: "100kb" }));
// ... rate limiter, auth, routes follow
```

Add global `Content-Type` response header (after routes, before error handler):
```typescript
app.use((_req, res, next) => {
  res.setHeader('Content-Type', 'application/json');
  next();
});
```

**File:** `src/index.ts` — confirm it imports `createApp` from `src/app.ts`. Remove any duplicated route definitions.

---

### Phase 6: Tests (2-3 hours)

**File:** `src/__tests__/contentNegotiation.test.ts`

**Test harness:** Use `createApp()` pattern from existing tests.

**Test cases (95% coverage on touched files):**

| Category | Cases |
|----------|-------|
| Content-Type valid | POST with `application/json` → passes through |
| Content-Type charset | POST with `application/json; charset=utf-8` → passes |
| Content-Type invalid | POST with `text/plain` → 415, correct envelope |
| Content-Type missing | POST without header → 415 |
| Accept valid | POST with `Accept: application/json` → passes |
| Accept wildcard | POST with `Accept: */*` → passes |
| Accept invalid | POST with `Accept: text/html` → 406 |
| GET no Content-Type | GET request → passes (no check) |
| GET no Accept | GET without Accept → passes |
| OPTIONS bypass | OPTIONS → passes (CORS preflight) |
| Webhook exclusion | POST to excluded path with any Content-Type → passes |
| Error envelope | 415/406 responses match `{ success, code, error }` |
| Middleware order | `express.json()` only runs after content check passes |
| Existing tests | Run full `npm test` to ensure no regressions |

**Coverage check:** `npm test -- --coverage` — verify 95% on `contentNegotiation.ts`, `errorHandler.ts`, `app.ts`.

---

### Phase 7: Documentation (30 min)

**File:** `docs/api/content-negotiation.md`

Contents:
- Table: method × header check matrix
- Error codes: 415 `UNSUPPORTED_MEDIA_TYPE`, 406 `NOT_ACCEPTABLE`
- Error envelope example
- Webhook exclusion list and rationale
- Security note: charset stripping prevents bypass, no header value leakage
- CORS preflight interaction note

---

### Phase 8: Verification (15 min)

```bash
npm run build
npm test
```

**Manual curl verification:**
```bash
# 415 — wrong Content-Type
curl -X POST http://localhost:3001/api/v1/slots \
  -H "Content-Type: text/plain" -d "test" -i

# 406 — wrong Accept
curl -X POST http://localhost:3001/api/v1/slots \
  -H "Content-Type: application/json" -H "Accept: text/html" \
  -d '{"professional":"t","startTime":"2026-01-01","endTime":"2026-01-02"}' -i

# 200 — valid
curl -X POST http://localhost:3001/api/v1/slots \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"professional":"t","startTime":"2026-01-01","endTime":"2026-01-02"}' -i

# GET works without Content-Type
curl -X GET http://localhost:3001/api/v1/slots -i

# Content-Type response header present
curl -s -D - http://localhost:3001/api/v1/slots | grep -i "content-type"
```

---

### Phase 9: Commit

```bash
git checkout -b feature/content-negotiation-guards
git add src/middleware/contentNegotiation.ts src/errors/ src/middleware/errorHandler.ts src/app.ts src/__tests__/contentNegotiation.test.ts docs/api/content-negotiation.md
git commit -m "feat: enforce json content negotiation"
```

---

### Summary of Touched Files

| Action | File |
|--------|------|
| Create | `src/middleware/contentNegotiation.ts` |
| Create | `src/errors/ContentNegotiationError.ts` (or add to `AppError.ts`) |
| Create | `src/__tests__/contentNegotiation.test.ts` |
| Create | `docs/api/content-negotiation.md` |
| Modify | `src/middleware/errorHandler.ts` |
| Modify | `src/app.ts` |
| Verify | `src/index.ts` (may need cleanup) |
| Verify | `src/routes/checkout.ts` (identify webhook paths) |

---

## Industry Standard Solutions to Known Flaws

1. **Webhook exclusion**: Read `src/routes/checkout.ts` first, then pass `excludePaths: string[]` to middleware — match against `req.path` with prefix/regex support for webhook routes like `/api/v1/checkout/webhook`.

2. **OPTIONS bypass**: Add `if (req.method === 'OPTIONS') return next();` as first line in middleware — CORS preflight must pass untouched.

3. **Accept header policy**: Only enforce on methods with body (POST/PUT/PATCH). Accept `*/*` as valid. Skip enforcement entirely on GET/DELETE. Check: `if (accept && !accept.includes('application/json') && !accept.includes('*/*')) return 406`.

4. **Content-Type scope**: Check Content-Type only on `['POST', 'PUT', 'PATCH']`. Skip on GET/DELETE/OPTIONS/HEAD. Use `req.method` guard before any header inspection.

5. **Charset handling**: Parse `req.headers['content-type']` → `header.split(';')[0].trim()` → compare to `'application/json'`. Ignore charset suffix entirely. Don't use strict equality on raw header.

6. **Entry point**: `package.json` shows `"start": "node dist/index.js"` — so `src/index.ts` is the entry. Update `src/index.ts` to import `createApp` from `src/app.ts`. Apply middleware in `src/app.ts` inside `createApp()`. Remove duplicated routes from `src/index.ts`.

7. **Middleware ordering**: Register content negotiation in `src/app.ts` BEFORE `express.json()`. Order: `cors()` → `contentNegotiation` → `express.json()` → rate limiter → auth → routes.

8. **Error propagation**: Middleware calls `next(new ContentNegotiationError(code, message))` — a custom error class with `statusCode` and `code` properties. Let `src/middleware/errorHandler.ts` detect and send envelope. Don't `res.status().json()` inside middleware.

9. **Missing Content-Type**: On POST/PUT/PATCH, if `!req.headers['content-type']` → call `next()` with 415 error. Don't let `express.json()` handle it (it silently skips parsing).

10. **Test compatibility**: Add `enableContentNegotiation?: boolean` to existing `AppFactoryOptions` interface in `src/app.ts`. Default `true`. Set `false` in existing test setups calling `createApp()`.
