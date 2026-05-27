# ChronoPay Backend Architecture

## Overview

ChronoPay is an Express/TypeScript API. This document defines the intended layering, where each concern lives, and the conventions every contributor should follow. It reflects the actual structure of `src/` as of this writing.

---

## Layer Map

```
HTTP Request
     │
     ▼
┌─────────────────────────────────────────────────────┐
│  src/routes/*.ts          (routing + HTTP I/O)       │
│  src/*/routes.ts                                     │
└──────────────────────┬──────────────────────────────┘
                       │ calls
┌──────────────────────▼──────────────────────────────┐
│  src/*/controller.ts      (request parsing,          │
│                            auth checks, responses)   │
└──────────────────────┬──────────────────────────────┘
                       │ calls
┌──────────────────────▼──────────────────────────────┐
│  src/services/*.ts        (stateless business logic) │
│  src/modules/*/service.ts                            │
└──────────────────────┬──────────────────────────────┘
                       │ calls
┌──────────────────────▼──────────────────────────────┐
│  src/repositories/*.ts    (data-access, one entity)  │
│  src/modules/*/repository.ts                         │
└──────────────────────┬──────────────────────────────┘
                       │ calls
┌──────────────────────▼──────────────────────────────┐
│  src/db/*.ts              (pg pool, transactions,    │
│  src/cache/*.ts            Redis, migrations)        │
└─────────────────────────────────────────────────────┘

Cross-cutting (applied at the route level, never inside services):
  src/middleware/*.ts   — auth, validation, rate-limiting, error handling, CORS, audit
  src/config/*.ts       — env parsing, CORS config
  src/errors/*.ts       — shared error types
```

---

## Layer Responsibilities

### 1. Routes — `src/routes/*.ts` / `src/*/routes.ts`

**Only** responsible for:
- Declaring the HTTP verb + path
- Attaching middleware in the correct order
- Delegating to a controller or inline handler

**Rules:**
- No business logic. No direct DB/cache calls.
- Middleware order must be: auth → validation → handler.
- Keep files short. If a route file exceeds ~80 lines, extract a controller.

```typescript
// ✅ correct
router.post(
  "/sessions",
  requireAuthenticatedActor(["customer"]),
  validateCreateCheckoutSession(),
  checkoutController.create,
);

// ❌ wrong — business logic in route file
router.post("/sessions", (req, res) => {
  const session = sessionStore.get(req.body.id); // belongs in service/repository
  res.json(session);
});
```

---

### 2. Controllers — `src/*/controller.ts`

**Only** responsible for:
- Parsing and typing `req.body`, `req.params`, `req.query`
- Calling the service layer
- Mapping service results / errors to HTTP responses

**Rules:**
- No raw DB/cache access.
- No business rules (those live in services).
- Catch domain errors and map them to status codes here, not in the service.
- Never log raw user input — use structured logging with redacted fields.

```typescript
// ✅ correct
async create(req: Request, res: Response) {
  const input = parseCreateBookingIntentBody(req.body); // parse/validate
  const result = await bookingIntentService.createIntent(input, req.auth!);
  res.status(201).json({ success: true, data: result });
}

// ❌ wrong — HTTP concern leaking into service
class BookingIntentService {
  create(req: Request) { ... } // services must not know about Request/Response
}
```

---

### 3. Services — `src/services/*.ts` / `src/modules/*/service.ts`

**Only** responsible for:
- Business rules and domain logic
- Orchestrating calls across multiple repositories
- Throwing typed domain errors (never HTTP status codes directly)

**Rules:**
- Must be framework-agnostic: no `Request`, `Response`, or `express` imports.
- Accept plain typed inputs; return plain typed outputs.
- Throw a domain error class (e.g. `BookingIntentError`, `CheckoutError`) — never `res.status(...)`.
- Injectable dependencies (repositories, clock) must be constructor params for testability.

```typescript
// ✅ correct — injectable, framework-free
export class BookingIntentService {
  constructor(
    private readonly repo: BookingIntentRepository,
    private readonly slots: SlotRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  createIntent(input: CreateBookingIntentInput, actor: AuthContext): BookingIntentRecord {
    const slot = this.slots.findById(input.slotId);
    if (!slot) throw new BookingIntentError(404, "Slot not found.");
    // ...
  }
}

// ❌ wrong — static class with module-level state
export class CheckoutSessionService {
  static createSession(req: Request) { ... } // avoid static + Request coupling
}
```

> Note: `src/services/checkout.ts` currently uses a static class with module-level `sessionStore`. This is a known deviation — it should be refactored to an injectable instance class backed by a repository when persistence is added.

---

### 4. Repositories — `src/repositories/*.ts` / `src/modules/*/repository.ts`

**Only** responsible for:
- CRUD operations for a single entity
- Translating between DB rows and domain types
- No business logic, no cross-entity joins (those belong in services)

**Rules:**
- Always define an interface alongside the implementation so services depend on the interface, not the concrete class.
- In-memory implementations are acceptable for development/testing; name them `InMemory*`.
- Never throw HTTP errors — throw plain `Error` or a domain error.
- Sanitize output: strip internal/private fields before returning (see `sanitizeSlot` in `slotService.ts`).

```typescript
// ✅ correct — interface + in-memory impl
export interface BookingIntentRepository {
  create(intent: Omit<BookingIntentRecord, "id">): BookingIntentRecord;
  findBySlotId(slotId: string): BookingIntentRecord | undefined;
}

export class InMemoryBookingIntentRepository implements BookingIntentRepository { ... }

// ❌ wrong — repository doing business logic
export class SlotRepository {
  bookSlot(slotId: string, userId: string) {
    if (slot.professional === userId) throw new Error("Cannot book own slot"); // ← service concern
  }
}
```

---

### 5. DB & Cache Clients — `src/db/*.ts` / `src/cache/*.ts`

**Only** responsible for:
- Managing the pg connection pool (`src/db/connection.ts`)
- Providing `withTransaction` for atomic operations
- Running migrations (`src/db/migrationRunner.ts`)
- Redis client lifecycle and slot cache helpers (`src/cache/`)

**Rules:**
- Repositories call these; services and routes must not import from `src/db` or `src/cache` directly.
- Pool errors must be caught and logged — never crash the process silently.
- Cache helpers must degrade gracefully when Redis is unavailable (see `slotCache.ts` pattern).

---

### 6. Middleware — `src/middleware/*.ts`

Applied at the route level. Never imported inside services or repositories.

| File | Purpose |
|---|---|
| `auth.ts` | Parses `x-chronopay-user-id` / `x-chronopay-role` headers into `req.auth` |
| `apiKeyAuth.ts` | Validates `x-api-key` header |
| `validation.ts` | `validateRequiredFields()` — checks body/query/params fields are present |
| `checkout-validation.ts` | Checkout-specific schema validation |
| `errorHandling.ts` | `notFoundHandler`, `jsonParseErrorHandler`, `genericErrorHandler` |
| `rateLimiter.ts` | Request rate limiting |
| `requestLogger.ts` | Structured request/response logging via pino |
| `audit.ts` | Audit trail middleware |
| `cors.ts` | CORS policy enforcement |
| `idempotency.ts` | Idempotency key handling |
| `featureFlags.ts` | Feature flag gate middleware |

**Middleware order in `createApp`:**
```
requestLogger → cors → rateLimiter → routes
  └─ per-route: auth → validation → handler
app.use: notFoundHandler → jsonParseErrorHandler → genericErrorHandler
```

---

### 7. Modules — `src/modules/*/`

A self-contained feature slice that owns its service + repository together. Use this pattern when a feature has both a service and a repository that are tightly coupled and unlikely to be shared.

```
src/modules/booking-intents/
  booking-intent-service.ts      ← domain logic
  booking-intent-repository.ts   ← data access + interface

src/modules/slots/
  slot-repository.ts             ← data access + interface
```

Modules are preferred over the flat `src/services/` + `src/repositories/` split for new features. Existing flat files (`src/services/slotService.ts`, `src/repositories/slotRepository.ts`) are legacy and should be migrated to modules over time.

---

## Where New Code Goes

| What you're adding | Where it goes |
|---|---|
| New API endpoint | `src/routes/<resource>.ts` |
| Request parsing + response shaping | `src/modules/<feature>/<feature>.controller.ts` |
| Business logic for a new feature | `src/modules/<feature>/<feature>.service.ts` |
| Data access for a new entity | `src/modules/<feature>/<feature>.repository.ts` |
| Shared cross-feature business logic | `src/services/<name>.ts` |
| Shared data access (no owning module) | `src/repositories/<name>.ts` |
| New middleware concern | `src/middleware/<name>.ts` |
| Env variable | `src/config/env.ts` — add to `EnvConfig`, parse in `loadEnvConfig` |
| Shared error type | `src/errors/AppError.ts` |
| DB migration | `src/db/migrations/<NNN>_<description>.ts` |

---

## Security Conventions

These apply to every layer.

### Input validation
- Validate and sanitize all external input at the route/controller boundary before it reaches the service.
- Use `validateRequiredFields()` for presence checks; write dedicated parse functions (like `parseCreateBookingIntentBody`) for structural validation.
- Reject unexpected fields — do not pass `req.body` directly to a repository.

### Authentication & authorization
- Authentication is resolved in middleware (`auth.ts`) and attached to `req.auth`.
- Authorization checks (ownership, role) belong in the controller, not the service.
- Services receive an `AuthContext` value type — they never read headers or `req`.

### Error messages
- Never surface internal error messages, stack traces, or DB errors to the client.
- The `genericErrorHandler` middleware is the last line of defense — it returns a generic 500.
- Domain errors (`BookingIntentError`, `CheckoutError`) carry a `status` code used by the controller; the message is safe to return to the client.

### Sensitive data
- Strip internal fields before returning data (e.g. `_internalNote` in `sanitizeSlot`).
- Never log PII (email, phone, payment details) in plain text — use structured logging with redacted fields.
- Secrets (API keys, DB URLs) come from environment variables only; never hardcode or commit them.

### Rate limiting & idempotency
- Apply `rateLimiter` globally.
- Use `idempotency.ts` middleware on mutating endpoints (`POST`, `PATCH`, `DELETE`) where duplicate requests could cause harm.

---

## Testing Conventions

- Unit tests live next to the code they test: `src/modules/<feature>/__tests__/` or `src/__tests__/`.
- Test files are named `<subject>.test.ts`.
- Services must be unit-testable without a running DB or Redis — inject `InMemory*` repositories.
- Use `resetSlotStore()` / `clearAll()` / `clearAllSessions()` helpers in `afterEach` to isolate state.
- Integration tests that need a real DB go in `src/__tests__/integration/` and are skipped in CI unless `DATABASE_URL` is set.
- Minimum coverage target: **95% of touched lines** on any PR.

```typescript
// ✅ correct — service test with injected in-memory deps
const repo = new InMemoryBookingIntentRepository();
const slots = new InMemorySlotRepository([{ id: "slot-1", bookable: true, ... }]);
const service = new BookingIntentService(repo, slots);

it("throws 404 when slot does not exist", () => {
  expect(() => service.createIntent({ slotId: "missing" }, actor))
    .toThrow(BookingIntentError);
});
```

---

## PR Review Checklist

Before requesting review, confirm:

**Architecture**
- [ ] New code lands in the correct layer (see "Where New Code Goes" above)
- [ ] Services have no `Request`/`Response` imports
- [ ] Repositories define and implement an interface
- [ ] Middleware is applied at the route level, not inside services

**Security**
- [ ] All external input is validated before reaching the service
- [ ] Auth check happens before validation middleware in route definition
- [ ] No secrets, PII, or internal error details returned to the client
- [ ] Internal fields stripped from repository output before returning
- [ ] No hardcoded secrets or credentials

**Error handling**
- [ ] Domain errors use a typed error class with a safe message
- [ ] Controllers map domain errors to HTTP status codes
- [ ] `genericErrorHandler` is the fallback — no unhandled promise rejections

**Testing**
- [ ] Unit tests cover the happy path and key error branches
- [ ] Service tests use injected in-memory repositories (no real DB/Redis)
- [ ] Test state is reset in `afterEach`
- [ ] Coverage on touched lines meets the 95% target

**Logging**
- [ ] Structured logging used (`logInfo`, `logError` from `src/utils/logger.ts`)
- [ ] No `console.log` in production paths
- [ ] No PII in log fields

---

## Known Deviations (Tech Debt)

| Location | Issue | Intended fix |
|---|---|---|
| `src/services/checkout.ts` | Static class with module-level `sessionStore` | Refactor to injectable instance class + repository |
| `src/routes/slots.ts` | In-memory `slotStore` inside route file | Move to `InMemorySlotRepository` in `src/modules/slots/` |
| `src/index.ts` | Duplicate `createApp` definition, mixed concerns | Consolidate into `src/app.ts` |
| `src/repositories/slotRepository.ts` | Flat repository outside modules | Migrate to `src/modules/slots/slot-repository.ts` |
| `src/services/slotService.ts` | Flat service outside modules | Migrate to `src/modules/slots/slot-service.ts` |
