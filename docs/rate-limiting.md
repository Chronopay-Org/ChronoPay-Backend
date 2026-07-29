# Rate Limiting

## Overview

ChronoPay Backend implements **auth-aware rate limiting** to provide fair usage controls while minimizing collateral damage from shared IP addresses (NAT, corporate proxies). The limiter keys requests by authenticated principal (user ID or API key) when available, and falls back to IP address for unauthenticated traffic.

## Scope

This feature was implemented as a focused, self-contained change. Pre-existing TypeScript compilation errors in other parts of the codebase (e.g., `cache/redisClient.ts`, `middleware/auth.ts`, `services/smsNotification.ts`) were **not addressed** as they were outside the scope of the task. The auth-aware rate limiting feature itself compiles and functions correctly in isolation.

---

## Key Strategy

### Priority Order

The rate limit key is generated in the following precedence:

1. **Header-based user ID** (`x-chronopay-user-id`) → key: `rl:user:<userId>`
2. **JWT user ID** (`req.user.sub` or `req.user.id`) → key: `rl:user:<userId>`
3. **API key** (`x-api-key` hashed) → key: `rl:apiKey:<sha256hash>`
4. **IP address** (`req.ip`, respects `trust proxy`) → key: `rl:ip:<ip>`

### Key Format

```
rl:{type}:{identifier}
```

- `type` — one of `user`, `apiKey`, `ip`
- `identifier` — stable unique identifier for the principal:
  - User ID from trusted headers or JWT
  - SHA-256 hash of the API key (not the raw key)
  - IP address string (IPv4 or IPv6)

This namespace ensures:
- No collision between different principal types
- Clear identification in Redis and logs
- Consistent keying across routes and server instances

## Configuration

Rate limiting is configured via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_WINDOW_MS` | `900000` (15 minutes) | Time window for the sliding bucket |
| `RATE_LIMIT_MAX` | `100` | Maximum requests per window per principal |
| `TRUST_PROXY` | `false` | When `true`, `req.ip` uses `X-Forwarded-For` (behind load balancer) |

All three are exposed via `ConfigService` and validated at startup.

## Usage

### Applying the Middleware

Import and use the **auth-aware** rate limiter **after** the authentication middleware that sets the identity:

```ts
import { createAuthAwareRateLimiter } from '../middleware/rateLimiter.js';
import { requireAuthenticatedActor } from '../middleware/auth.js';

router.post(
  '/',
  requireAuthenticatedActor(['customer', 'admin']),
  createAuthAwareRateLimiter(), // ← after auth, sees req.auth.userId
  handler
);
```

For API-key-protected routes:

```ts
import { requireApiKey } from '../middleware/apiKeyAuth.js';

router.post(
  '/',
  requireApiKey(process.env.API_KEY),
  createAuthAwareRateLimiter(), // ← after requireApiKey sees req.apiKeyId
  handler
);
```

For JWT-protected routes:

```ts
import { authenticate } from '../middleware/auth.middleware.js';

router.get(
  '/profile',
  authenticate,
  createAuthAwareRateLimiter(), // ← after authenticate sees req.user
  handler
);
```

### Custom Limits per Route

Override defaults with explicit window and max:

```ts
createAuthAwareRateLimiter(15 * 60 * 1000, 200); // 200 req / 15 min
```

### Test Mode

When `NODE_ENV=test`, rate limiting is automatically skipped to prevent flaky tests. No configuration needed.

## Security Notes

### Authentication Order

The rate limiter **must** be placed **after** authentication middleware. Otherwise, `req.auth`, `req.user`, or `req.apiKeyId` will be undefined and the request falls back to IP-based limiting. This is secure but reduces fairness.

### Identity Spoofing Prevention

- **Header-based auth** (`x-chronopay-user-id`): The system assumes these headers are set by a **trusted upstream** (API gateway, authentication service). If the API is directly exposed, an attacker could set any user ID and exhaust that user's quota (Denial-of-Service on the account). This is an architectural assumption – ensure such routes are behind a trusted proxy that validates and injects these headers.
- **API keys**: The raw key is never stored; only its SHA-256 hash appears in Redis. Even if Redis is compromised, the raw keys cannot be recovered.
- **JWT**: Token signature and claims are verified by `authenticate` middleware before `req.user` is populated.

### No Bypass via Identity Toggling

Different principal types are isolated: a user cannot switch to an API key mid-session to get a fresh quota because the key generation picks the **first available** identity in a fixed priority order. If an attacker tries to omit headers, they fall back to IP, which is still rate-limited.

### Trust Proxy and IP Spoofing

When `TRUST_PROXY=true`, the application uses `X-Forwarded-For` to determine client IP. Ensure this setting is enabled **only** if you are behind a trusted load balancer that sanitizes the header. Otherwise, clients can spoof their IP to bypass limits.

### Shared Store Across Instances

All server instances must use the same Redis store. The implementation uses a shared `RedisStore` with a common prefix (`rl:`), ensuring consistent counters across horizontal scaling.

### Key Namespace Isolation

Rate limit keys use the `rl:` prefix to avoid collisions with other Redis data:
- Slot cache: `slots:*`
- Idempotency: `idempotency:*`
- HMAC replay: `replay:*`

Do not use `rl:` for other purposes.

## Observability

### RateLimit Header

Every response includes the standard `RateLimit` header (draft-7 format):

```
RateLimit: limit=100, remaining=87, reset=1711072800
```

- `limit` — the effective maximum for the current principal
- `remaining` — requests left in the current window
- `reset` — Unix timestamp when the window resets

This header is automatically added by `express-rate-limit`.

### Metrics

Existing Prometheus metrics (see `metrics.ts`) cover slot cache and slow queries. Rate limiting counters are stored in Redis and can be monitored via:

- `redis_keyspace` metrics (key count, memory used)
- Custom instrumentation can be added later (e.g., `rate_limit_blocks_total` labeled by `principal_type`)

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| All users share the same limit | Auth middleware not mounted before rate limiter | Ensure `requireAuthenticatedActor` / `authenticate` / `requireApiKey` run before `createAuthAwareRateLimiter` |
| Rate limiter never triggers | Limit too high or Redis store not shared | Check `RATE_LIMIT_MAX`; confirm Redis is connected (logs) |
| Every request gets 429 | Limit too low or shared `apiKeyId` among many services | Increase limit or use per-service API keys |
| No `RateLimit` header | Middleware not applied or `standardHeaders` disabled | Verify order and that `standardHeaders: 'draft-7'` is set |
| IP-based fallback not working | `TRUST_PROXY` not set behind proxy; or no proxy needed but requesting from different IPs | Set `TRUST_PROXY=true` if behind load balancer; else check client IP variation |
| Redis connection errors | Redis URL malformed or unreachable | Validate `REDIS_URL`, network connectivity |

## Migration from IP-Only

The previous rate limiter (if ever enabled) used per-IP keys. The new limiter is **backward compatible** in the sense that:
- All existing routes without auth naturally fall back to IP keys.
- No configuration changes required unless you want different limits per principal type.

To migrate, simply replace any usage of `createRateLimiter()` with `createAuthAwareRateLimiter()` on routes that have authentication. You may keep both if you need mixed behavior (some endpoints IP-only, others auth-aware).

## Future Enhancements

- Per-principal rate limit tiers (free vs premium) via separate config or database lookup.
- Dynamic adjustments based on system load.
- `Retry-After` header in 429 responses.
- Prometheus metrics with `principal_type` label.

---

## Internal Fair-Queue Override (Signed Bypass Header)

Certain internal services (e.g. payout workers, settlement reconcilers) must
be able to bypass the fair-queue rate limiter without acquiring a user or API
key identity. ChronoPay provides a **signed override header** mechanism for
this purpose.

### Design Goals

- **Secure** — signatures are short-lived (30 s default tolerance) and
  scoped to a specific route, preventing replay attacks across endpoints.
- **Auditable** — every successful bypass is logged with the actor ID and route.
- **Observable** — all bypass attempts (valid and invalid) increment the
  `fair_queue_bypass_attempts_total` Prometheus counter, labelled by `result`.
- **Zero-downtime rotation** — supports a current and a previous signing
  secret simultaneously so secrets can be rotated without a coordinated deploy.

### Headers

Callers must send **all three** headers:

| Header | Format | Description |
|--------|--------|-------------|
| `x-bypass-actor` | Printable ASCII, 1–128 chars | Stable identifier for the calling service (e.g. `payout-worker`) |
| `x-bypass-ts` | Integer (Unix seconds) | Current time, used to enforce the tolerance window |
| `x-bypass-sig` | `sha256=<64-char hex>` or raw 64-char hex | HMAC-SHA256 of the signed message |

If any header is present but the others are absent, the middleware returns
`401` immediately. If none are present, the request passes through to normal
rate-limiting logic.

### Signature Scope

The signed message is the following newline-delimited string:

```
<actorId>\n<route>\n<timestamp>
```

- `<actorId>` — value of `x-bypass-actor`
- `<route>` — `req.path` on the server (e.g. `/api/v1/slots`)
- `<timestamp>` — integer value of `x-bypass-ts`

This binds the signature to the exact combination of actor, endpoint, and time.

### Generating a Signature

```ts
import { createHmac } from "node:crypto";

const actorId = "payout-worker";
const route   = "/api/v1/slots";
const ts      = Math.floor(Date.now() / 1000);
const secret  = process.env.INTERNAL_OVERRIDE_SECRET!;

const message = `${actorId}\n${route}\n${ts}`;
const sig     = "sha256=" + createHmac("sha256", secret).update(message).digest("hex");

// Attach to request:
headers["x-bypass-actor"] = actorId;
headers["x-bypass-ts"]    = String(ts);
headers["x-bypass-sig"]   = sig;
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INTERNAL_OVERRIDE_SECRET` | No | — | Current signing secret. Bypass is disabled if absent. |
| `INTERNAL_OVERRIDE_SECRET_PREV` | No | — | Previous signing secret (zero-downtime rotation). |
| `INTERNAL_BYPASS_TOLERANCE_MS` | No | `30000` | Clock-skew tolerance in milliseconds. |

### Secret Rotation

To rotate without downtime:

1. Set `INTERNAL_OVERRIDE_SECRET_PREV` to the current value of
   `INTERNAL_OVERRIDE_SECRET`.
2. Set `INTERNAL_OVERRIDE_SECRET` to the new secret.
3. Deploy callers one by one, switching them to sign with the new secret.
4. Once all callers have been migrated, remove `INTERNAL_OVERRIDE_SECRET_PREV`.

Both secrets are accepted during the overlap window.

### Middleware Mounting

Mount `fairQueueBypass` **before** `createAuthAwareRateLimiter`:

```ts
import { fairQueueBypass } from "../middleware/internalHmacAuth.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";

router.get(
  "/api/v1/slots",
  fairQueueBypass(),       // sets req.internalBypassActor on success
  createAuthAwareRateLimiter(), // skips rate limiting when req.internalBypassActor is set
  handler,
);
```

Or mount globally in `app.ts` before any rate-limited router:

```ts
app.use(fairQueueBypass());
```

### Error Responses

| HTTP Status | Condition |
|------------|-----------|
| `401` | Incomplete or malformed headers (bad actor, bad timestamp, bad sig format) |
| `403` | Valid format but signature check failed — expired, wrong route, HMAC mismatch, or secret not configured |

### Observability

The counter `fair_queue_bypass_attempts_total` is incremented for every attempt:

| `result` label | Meaning |
|---------------|---------|
| `valid` | Bypass granted |
| `missing` | No bypass headers present (normal request) |
| `expired` | Timestamp outside tolerance window |
| `invalid_sig` | HMAC did not match any known secret |
| `bad_format` | Headers present but malformed |

### Security Notes

- **Replay protection** — The 30 s tolerance window means a captured token
  is only usable for at most 30 s. Combined with route-binding, a replay
  on a different endpoint is rejected.
- **Timing-safe comparison** — Signatures are compared with `timingSafeEqual`
  from `node:crypto` to prevent timing oracles.
- **No secret → no bypass** — If `INTERNAL_OVERRIDE_SECRET` is not set, any
  bypass attempt returns `403`. The feature is disabled by default.
- **Never expose secrets in responses** — Validation errors do not echo any
  secret material back to the caller.

---

**Last Updated**: 2026-07-29  
**Version**: 1.1.0
