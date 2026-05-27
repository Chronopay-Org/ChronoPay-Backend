# ChronoPay API — Header Validation Reference

> **Module:** `src/middleware/headerValidation.ts`  
> **Applies to:** All routes that use idempotency, request tracing, or webhook signature verification.

---

## Overview

ChronoPay enforces strict validation rules on key HTTP request headers. The goals are:

1. **Security** — Prevent header-injection attacks (CRLF, null-byte), log-pollution, and Redis key-space abuse.
2. **Consistency** — Ensure that all consumers of these headers receive values in a predictable, safe format.
3. **Abuse prevention** — Reject overlong values before they reach downstream systems (Redis, structured logs, HMAC verifiers).

---

## Headers

### `Idempotency-Key`

| Property         | Value |
|-----------------|-------|
| Required         | No — opt-in per request |
| Max length       | 255 characters |
| Allowed chars    | `[a-zA-Z0-9\-_.]` |
| HTTP error       | `400 Bad Request` when present but invalid |

**Purpose:** Allows clients to safely retry mutating operations (e.g., POST /api/v1/slots) without duplicating side-effects. The key is stored in Redis for 24 hours.

**Valid examples:**
```
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Idempotency-Key: order-42_v1.0
Idempotency-Key: payment.retry.001
```

**Invalid examples (rejected with `400`):**
```
# Overlong (> 255 chars)
Idempotency-Key: aaa...aaa

# Contains spaces
Idempotency-Key: my key here

# CRLF injection attempt
Idempotency-Key: key\r\nX-Injected: evil

# Unicode
Idempotency-Key: clé-idempotence

# Path traversal characters
Idempotency-Key: ../etc/passwd
```

**Security notes:**
- The key is validated **before** it reaches Redis. Malformed keys never touch the cache layer.
- Overlong keys are rejected to prevent Redis key-size abuse and log-line flooding.
- The allow-list regex rejects all control characters, CRLF sequences, and null bytes.

---

### `X-Request-Id`

| Property         | Value |
|-----------------|-------|
| Required         | No — optional tracing header |
| Max length       | 128 characters |
| Allowed chars    | `[a-zA-Z0-9\-_.:] ` |
| HTTP error       | `400 Bad Request` when present but invalid |

**Purpose:** If supplied by an upstream proxy or API gateway, this value is used as the request trace ID in structured logs. When absent, the logger generates a synthetic ID (`req_<timestamp>_<random>`).

**Valid examples:**
```
X-Request-Id: 550e8400-e29b-41d4-a716-446655440000
X-Request-Id: req_1711324800000_abc123xyz
X-Request-Id: gateway:req_001
```

**Invalid examples (rejected with `400` or silently overridden in the logger):**
```
# Overlong (> 128 chars)
X-Request-Id: rrr...rrr

# CRLF injection
X-Request-Id: req\r\nX-Injected: evil
```

**Security notes:**
- The `genReqId` function in `requestLogger.ts` validates the incoming header value before accepting it. If it fails, the logger silently generates a safe synthetic ID instead of rejecting the request (the logger is non-blocking).
- The `validateRequestIdHeader` middleware, if mounted explicitly, will return `400` for invalid values.

---

### `X-Webhook-Signature` / `X-Hub-Signature-256`

| Property         | Value |
|-----------------|-------|
| Required         | **Yes** — on webhook routes |
| Max length       | 512 characters |
| Allowed chars    | Hex digits `[a-fA-F0-9]`, optionally prefixed with `sha256=` |
| HTTP error       | `400 Bad Request` when absent or invalid |

**Purpose:** HMAC-SHA256 signature header sent by the webhook originator to authenticate the payload. ChronoPay supports both raw hex digests and the GitHub-style `sha256=<hex>` format.

**Valid examples:**
```
X-Webhook-Signature: sha256=3d4e5f...abcdef
X-Webhook-Signature: aabbccddeeff0011223344556677889900aabbccddeeff0011223344556677889900
X-Hub-Signature-256: sha256=3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a
```

**Invalid examples (rejected with `400`):**
```
# Missing entirely
(no header)

# Contains non-hex characters
X-Webhook-Signature: sha256=xyz!!!invalid

# Overlong (> 512 chars)
X-Webhook-Signature: aaa...aaa

# CRLF injection
X-Webhook-Signature: sha256=abc\r\ninjected: evil
```

**Security notes:**
- Signature headers are mandatory on webhook routes. Absence always returns `400`.
- The length cap prevents resource exhaustion in HMAC comparison routines.
- Only a strict hex allow-list is accepted — no base64, no binary.

---

## Middleware Reference

All validators live in `src/middleware/headerValidation.ts` and are pure, dependency-free functions.

### Pure validator functions

```typescript
import {
  validateIdempotencyKey,
  validateRequestId,
  validateWebhookSignature,
  hasNoInjectionChars,
} from "./middleware/headerValidation.js";

const result = validateIdempotencyKey("my-key-001");
// { valid: true }

const bad = validateIdempotencyKey("a".repeat(300));
// { valid: false, reason: "Idempotency-Key exceeds maximum length of 255 characters" }
```

Each function returns a `HeaderValidationResult`:

```typescript
interface HeaderValidationResult {
  valid: boolean;
  reason?: string; // present when valid === false
}
```

### Express middleware

```typescript
import {
  validateIdempotencyKeyHeader,   // opt-in: only validates when header is present
  validateRequestIdHeader,        // opt-in: only validates when header is present
  validateWebhookSignatureHeader, // required: rejects when header is absent
} from "./middleware/headerValidation.js";

// Mount before idempotencyMiddleware
app.post(
  "/api/v1/slots",
  validateIdempotencyKeyHeader,   // guards Idempotency-Key
  validateRequestIdHeader,        // guards X-Request-Id
  idempotencyMiddleware,
  handler,
);

// Mount on webhook routes with a custom header name
app.post(
  "/api/v1/webhooks/settlements",
  validateWebhookSignatureHeader("X-Hub-Signature-256"),
  webhookHandler,
);
```

---

## Error Response Format

All validation failures return a `400 Bad Request` with the standard error envelope:

```json
{
  "success": false,
  "error": "<human-readable reason>"
}
```

**Example responses:**

```json
// Overlong Idempotency-Key
{ "success": false, "error": "Idempotency-Key exceeds maximum length of 255 characters" }

// Invalid characters in X-Request-Id
{ "success": false, "error": "X-Request-Id contains invalid characters. Allowed: alphanumerics, hyphens (-), underscores (_), colons (:), and dots (.)" }

// Missing webhook signature
{ "success": false, "error": "Webhook signature header is missing" }
```

---

## Security Assumptions

| Threat                          | Mitigation |
|--------------------------------|------------|
| Overlong header DoS            | Hard length caps on all validated headers |
| CRLF / header injection        | Allow-list regex rejects `\r`, `\n`, and all ASCII control chars |
| Null-byte injection            | Regex and `hasNoInjectionChars()` reject `\0` |
| Redis key-space pollution      | Idempotency-Key validated before Redis is touched |
| Log injection via request ID   | `genReqId` validates before accepting proxy-supplied IDs |
| Webhook spoofing               | Signature header is mandatory; only hex digits accepted |
| Unicode smuggling              | Allow-list regexes are ASCII-only; Unicode ranges rejected |

---

## Testing

Run only the header validation tests:

```bash
npx jest --testPathPattern="headerValidation"
```

Run the full suite:

```bash
npm test
```

Test file: `src/__tests__/headerValidation.test.ts`

Coverage target: ≥ 95 % of lines in `src/middleware/headerValidation.ts`.
