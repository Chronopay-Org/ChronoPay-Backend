# Idempotency in ChronoPay-Backend

Idempotency allows clients to safely retry requests without accidentally performing the same operation twice. This is particularly critical for payment and scheduling transactions where race conditions or network timeouts could result in duplicate records.

## Opt-in Idempotency
To make a request idempotent, clients must provide a unique `Idempotency-Key` header. If the header is missing, the request proceeds normally and is not cached.

```http
POST /api/v1/slots HTTP/1.1
Idempotency-Key: req_12345
```

## Strong Idempotency Binding

To prevent **cross-endpoint and cross-caller replay**, the Redis storage entry for an `Idempotency-Key` is derived from four elements (see `src/middleware/idempotencyStorageKey.ts`):
1. **Caller Principal** — the *verified* identity attached by auth middleware: `req.auth.userId`, JWT `sub`, or `req.apiKeyId`. Requests without a verified principal fall back to a **hashed client-IP namespace**, so anonymous callers keep working exactly as before while staying isolated per network origin.
2. **Request Method** (e.g., `POST`)
3. **Matched Route** (e.g., `/api/v1/booking-intents`)
4. **The raw `Idempotency-Key` value**

The parts are hashed with SHA-256, which bounds the storage key's length and keeps user IDs, IP addresses and raw key values out of Redis key names. Each stored entry additionally records a deterministic SHA-256 **payload hash** of the JSON body.

### Rejection Scenarios
- **Payload Mismatch (422 Unprocessable Entity)**: If the client sends the same key to the same route but alters the request body, the server will return a `422 Unprocessable Entity`.
- The same key value used on **different routes** or by **different callers** resolves to independent entries — never a shared or replayed response.

### Ordering Requirement

`idempotencyMiddleware` must be mounted **after authentication** (`requireAuth`, `requireAuthenticatedActor`, `apiKeyAuth`, or `optionalAuth` on routes with optional auth) so the storage key is namespaced by the verified principal. The principal must come from verified auth — never from raw client-supplied headers. On routes where authentication is optional (e.g. `POST /api/v1/checkout/sessions`), `optionalAuth()` verifies a presented JWT without rejecting the request, so absent or invalid tokens fall back to the anonymous (hashed-IP) namespace.
- **Endpoint Mismatch (409 Conflict)**: If a client reuses the same `Idempotency-Key` for a different route or HTTP method, the server will deterministically reject it with a `409 Conflict`.
- **Payload Mismatch (422 Unprocessable Entity)**: If the client sends the same key to the same route but alters the request body, the server will return a 422 Unprocessable Entity`.

## Security Assumptions

- **Stable Hashing**: The JSON request body is deeply and deterministically sorted before hashing. This means that two payloads with the exact same data but keys ordered differently will correctly resolve to the exact same hash.
- **Data Privacy**: The server **never logs or stores** the raw request payload within the idempotency lock. Instead, the payload is reduced to a one-way `SHA-256` hash. This guarantees that sensitive fields (like PII or payment details) are never leaked into the Redis idempotency storage.

## Redis Lock Lifecycle (TTL)

Idempotency uses two distinct TTL windows:

1. **Processing lock** — set with `NX EX` when the request first arrives. The default TTL is **60 seconds** and is configurable via `IDEMPOTENCY_PROCESSING_LOCK_TTL_SECONDS`. This is deliberately short so a crashed handler, a missed response lifecycle event, or a client abort cannot lock a key for the full completed retention window.
2. **Completed response** — written only for deterministic **2xx and 4xx** responses and kept for **24 hours**. After this period, a retry using the same key will be treated as a completely new request.

## Failure Handling

- **5xx responses are never cached.** When a handler returns a 5xx status (e.g., a DB outage or an FX provider error), the middleware `DEL`s the idempotency key so a correct retry with the same key can succeed.
- **Responses that bypass `res.json`** (e.g., `res.send`, `res.end`, a timeout, or a client abort) trigger a cleanup on the `response` finish/close events. The processing key is deleted so the key is not stuck in the `processing` state.
- **Concurrent retries** receive `409 IDEMPOTENCY_IN_PROGRESS` while the first request is in flight.

## Middleware Test Coverage

The middleware behavior is covered by `src/middleware/__tests__/idempotency.test.ts`.

- Replay of stored responses for identical retries by the same caller
- Cross-caller isolation: two users reusing the same key value each get their own fresh response (cross-user replay regression)
- Cross-route isolation: the same key value on two different routes does not collide
- `422` payload mismatch for same key and different body hash
- Replay of stored responses for identical retries (201 cached)
- `422` payload mismatch for same key and different body hash (and 422 cached)
- 500 responses are not cached and the handler runs again on retry
- `res.end()` cleans up the processing key
- Client abort cleans up the processing key
- Concurrency guard (`409`) so concurrent first-requests with same key do not both execute
- Missing-key pass-through behavior
- Expired-key behavior (treated as a new request)
- Redis-unavailable fail-closed behavior (`503`)
- Encryption codec security checks (no plaintext leak, tamper detection)

### Collision and Trust Assumption

Idempotency correctness assumes:

1. SHA-256 request hashes and storage-key derivations are collision-resistant in practice.
2. Redis idempotency entries are trusted and not tampered with by untrusted actors.
3. The caller principal is established by verified authentication middleware mounted before the idempotency middleware.

If a collision were to occur (or a cache entry were maliciously forged with a matching hash), the middleware would replay the cached response because the hash is the binding primitive.
