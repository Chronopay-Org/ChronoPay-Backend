# Bookings Search API — `/api/v1/bookings/search`

Search endpoint for booking records, protected by a **per-tenant leaky-bucket
rate limiter** (60 rps sustained, 120 burst) instead of the coarse global
fixed-window limiter used elsewhere. This document covers the endpoint itself
and the rate-limiting behavior clients and operators must understand.

Implementation:

| Piece | Location |
| --- | --- |
| Router | `src/routes/bookings.ts` |
| Per-tenant leaky-bucket middleware | `src/middleware/tenantLeakyBucket.ts` |
| Metrics | `src/metrics.ts` (`rate_limit_bucket_burn`, `rate_limit_redis_failures_total`) |
| Config | `src/config/env.ts` (`BOOKINGS_SEARCH_*`) |

---

## Why per-tenant instead of the global limiter?

The previous configuration shared one fixed-window budget across traffic. A
single misbehaving tenant (retry storm, broken sync loop, aggressive scraper)
could exhaust the window and starve every other tenant — the classic *noisy
neighbor* failure. The per-tenant leaky bucket gives **each tenant its own
independent budget**, so an abusive tenant can only ever throttle itself:

```
tenant A: [████████████████████████████] 429 — throttled, burns alone
tenant B: [█░░░░░░░░░░░░░░░░░░░░░░░░] 200 — unaffected
```

## Algorithm

Leaky bucket, evaluated atomically inside Redis (Lua script):

- Each admitted request adds **1 token** to the caller's bucket.
- The bucket **drains at a constant rate**: `BOOKINGS_SEARCH_RATE_PER_SECOND`
  tokens/second (default **60**).
- Requests are admitted while `level + 1 <= BOOKINGS_SEARCH_BURST` (default
  **120**).

Consequences:

- **Burst:** up to 120 requests may land simultaneously.
- **Sustained:** long-run throughput converges to exactly 60 rps.
- **Recovery:** after throttling, capacity returns continuously at 60 rps
  (no hard window boundary, so no thundering-herd at window reset).

The Lua script runs via `EVALSHA` with an automatic `EVAL` fallback on
`NOSCRIPT`, so the read-modify-write of bucket state is atomic across all app
instances — concurrent requests cannot double-spend capacity.

### Redis state

- Key: `rlb:bookings:search:<principal-type>:<id>` (hash `{level, ts}`).
- TTL: `2 × (burst / rate) + 1` seconds (5 s with defaults), refreshed on
  every request. Buckets of quiet tenants expire automatically — no memory
  leak from one-off tenants.

## Tenant identity resolution

**Tenant keys are derived from trusted auth context only.** Resolution order:

1. `req.auth.tenantId` / `req.user.tenantId` — true tenant claims.
2. `req.auth.userId` / `req.user.sub || req.user.id` — the user is the tenant boundary.
3. `req.apiKeyId` — partner API keys map 1:1 to tenants (SHA-256 hashed).
4. Client IP (SHA-256 hashed) — anonymous traffic gets its own bucket and
   cannot starve authenticated tenants.

> [!IMPORTANT]
> The `x-tenant-id` **request header is never consulted**: trusting it would
> let any caller mint a fresh, empty bucket per request (limit evasion) and
> would flood Redis and Prometheus with unbounded keys. Identifiers are also
> canonicalized (strict charset + 128-char cap, otherwise replaced by a
> deterministic hash) before being embedded in keys, preventing Redis
> key-injection across logical namespaces.

## Headers

Every response (admitted or rejected) includes:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | Burst capacity (120). |
| `X-RateLimit-Remaining` | Tokens remaining in the tenant's bucket right now. |
| `X-RateLimit-Reset` | Epoch seconds when the bucket will have fully drained. |
| `Retry-After` | **Only on 429.** Whole seconds until the request can be retried successfully. Computed from live bucket state, not a constant. |

## Responses

**Admitted**

```json
{ "success": true, "data": { "results": [], "total": 0, "limit": 50, "offset": 0 } }
```

**Throttled — HTTP 429**

```json
{ "success": false, "error": "Too many requests, please try again later.", "retryAfter": 1 }
```

Client guidance: respect `Retry-After`, add jitter, and never retry 429s in a
tight loop — a retry storm only re-fills your own bucket with condemned
requests.

## Failure modes

The limiter is **fail-open**: if Redis is unreachable or slower than
`BOOKINGS_SEARCH_REDIS_TIMEOUT_MS` (default 250 ms), the request is admitted
without accounting and `rate_limit_redis_failures_total` increments.

Rationale: rate limiting exists to protect the endpoint; it must never take
the endpoint down with it. During a Redis outage, traffic degrades to the
pre-fix (unlimited) behavior and protection recovers automatically when Redis
returns. If `rate_limit_redis_failures_total` is sustained non-zero, treat it
as a production incident (Redis health), not as an application bug.

A too-slow Redis additionally cannot hang request handling — every store call
is wrapped in the hard `BOOKINGS_SEARCH_REDIS_TIMEOUT_MS` budget.

## Metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `rate_limit_bucket_burn` | Gauge | `tenant` | Live bucket fill level per tenant. Rising ⇒ about to be throttled; pinned at 120 ⇒ being throttled. Cardinality-budgeted (256) — excess tenants fold into the shared overflow label instead of harming the metrics pipeline. |
| `rate_limit_redis_failures_total` | Counter | — | Fail-open events (Redis error/timeout). Healthy steady state is 0. |

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `BOOKINGS_SEARCH_RATE_PER_SECOND` | `60` | Sustained rps per tenant (leak rate). |
| `BOOKINGS_SEARCH_BURST` | `120` | Per-tenant burst capacity. |
| `BOOKINGS_SEARCH_REDIS_TIMEOUT_MS` | `250` | Hard budget for the limiter Redis call before failing open. |

Tuning notes: keep `burst >= 2 × rate` so dashboards and batch syncs can
burst naturally; raise `rate` only together with capacity planning on the
search backing store.

## Endpoint

`GET /api/v1/bookings/search`

Auth: `x-chronopay-user-id` + role header (`customer`, `professional`,
`admin`, `support`) — callers only ever see **their own** bookings.

| Query param | Type | Description |
| --- | --- | --- |
| `q` | string ≤ 200 chars | Case-insensitive match over id, slotId, professional, note. |
| `status` | enum | `pending`, `confirmed`, `firm`, `cancelled`, `expired`, `hold_placed`, `hold_refunded`. |
| `slotId` | string | Exact slot filter. |
| `from`, `to` | ISO 8601 | Only bookings overlapping `[from, to]`. One-sided ranges allowed. `from` must not be after `to`. |
| `limit` | int 1–100 (default 50) | Page size. |
| `offset` | int ≥ 0 (default 0) | Page offset. |

Validation failures return `400 { success: false, error }`.

## Tests

- `src/middleware/__tests__/tenantLeakyBucket.test.ts` — decision engine,
  tenant resolution/security, middleware behavior, burst-then-sustained,
  tenant switch mid-connection, fail-open, latency-spike timeout.
- `src/middleware/__tests__/tenantLeakyBucket.redis.test.ts` — proves the
  Lua script on a real Lua VM (`ioredis-mock`) behaves identically to the JS
  decision engine (burst, throttle, drain, clock skew), plus EVALSHA caching
  and store lifecycle.
- `src/routes/__tests__/bookings.test.ts` — endpoint search/filter/pagination
  contract and the end-to-end noisy-neighbor scenario.

Coverage for both new modules: 100% lines / 100% functions / ≥97% branches.
