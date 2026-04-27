# Idempotency in ChronoPay-Backend

Idempotency allows clients to safely retry requests without accidentally performing the same operation twice. This is particularly critical for payment and scheduling transactions where race conditions or network timeouts could result in duplicate records.

## Opt-in Idempotency
To make a request idempotent, clients must provide a unique `Idempotency-Key` header. If the header is missing, the request proceeds normally and is not cached.

```http
POST /api/v1/slots HTTP/1.1
Idempotency-Key: req_12345
```

## Strong Idempotency Binding

To prevent **cross-endpoint replay confusion**, an idempotency key is tightly bound to three elements:
1. **Request Method** (e.g., `POST`)
2. **Request Path** (e.g., `/api/v1/slots`)
3. **Payload Hash** (Deterministic SHA-256 hash of the JSON body)

### Rejection Scenarios
- **Endpoint Mismatch (409 Conflict)**: If a client reuses the same `Idempotency-Key` for a different route or HTTP method, the server will deterministically reject it with a `409 Conflict`.
- **Payload Mismatch (422 Unprocessable Entity)**: If the client sends the same key to the same route but alters the request body, the server will return a `422 Unprocessable Entity`.

## Security Assumptions

- **Stable Hashing**: The JSON request body is deeply and deterministically sorted before hashing. This means that two payloads with the exact same data but keys ordered differently will correctly resolve to the exact same hash.
- **Data Privacy**: The server **never logs or stores** the raw request payload within the idempotency lock. Instead, the payload is reduced to a one-way `SHA-256` hash. This guarantees that sensitive fields (like PII or payment details) are never leaked into the Redis idempotency storage.

## Redis Lock Lifecycle (TTL)
Once a request successfully completes, its response status and body are written to Redis with a TTL (Time-To-Live) of 24 hours. After this period, the key expires, and a retry using the same key will be treated as a completely new request.
