# Caching Strategy

## Overview

`GET /api/v1/slots` is protected by a two-layer caching strategy:

1. **Redis cache** — shared across all processes; TTL controlled by `REDIS_SLOT_TTL_SECONDS` (default 60 s).
2. **Single-flight (in-flight deduplication)** — process-local guard that prevents a cache stampede when the Redis entry expires under concurrent load.

## Single-flight (stampede protection)

A cache stampede occurs when many concurrent requests arrive simultaneously on a cold cache, each independently triggering an expensive origin fetch.

`getOrFetchSlots` in `src/cache/slotCache.ts` prevents this with a single-flight pattern:

```
Request A ──► cache MISS ──► starts origin fetch ──► writes cache ──► returns data
Request B ──► cache MISS ──► in-flight exists ──────► joins A's Promise ──► returns same data
Request C ──► cache MISS ──► in-flight exists ──────► joins A's Promise ──► returns same data
```

- Only **one** origin fetch runs per cache key at any time.
- All other concurrent requests wait on the same `Promise` and receive the same result.
- The in-flight entry is removed (via `.finally()`) whether the fetch succeeds or throws.

### Response header

`X-Cache` is set on every `GET /api/v1/slots` response:

| Value | Meaning |
|---|---|
| `HIT` | Served from Redis cache |
| `MISS` | Cache was cold; origin was fetched |
| `MISS` | Request was coalesced (stampede blocked); still reports `MISS` to the client |

## Cache invalidation

Any write operation (`POST /api/v1/slots`, `PUT`, `DELETE`) calls `invalidateSlotsCache()`, which issues a `DEL slots:all` to Redis. The next `GET` will be a cache miss and re-populate the cache from the origin.

Invalidation is **eager** (write-through invalidation): the cache entry is deleted immediately after a successful write, not lazily on the next read.

## Metrics

Three Prometheus counters are exported from `src/metrics.ts`:

| Metric | Description |
|---|---|
| `slot_cache_hits_total` | Requests served from Redis cache |
| `slot_cache_misses_total` | Requests that triggered an origin fetch |
| `slot_cache_stampede_blocked_total` | Concurrent requests coalesced by single-flight |

Scrape them at `GET /metrics` (Prometheus format).

## Security notes

- **No user-specific data in the cache.** The `slots:all` key stores public slot listings only. There is no per-user or per-session data in the cache, so there is no risk of cross-user data leakage.
- **Cache-Control: no-store** is set on slot responses so browsers and CDNs do not cache mutable scheduling data.
- **Cloned data.** Slot arrays are cloned before being returned from the service layer to prevent callers from mutating cached state.
- **Graceful degradation.** If Redis is unavailable, all cache operations are silently skipped and requests fall through to the origin. The API remains functional; only caching is disabled.
- **TTL-bounded exposure.** Even if stale data is served, it expires within `REDIS_SLOT_TTL_SECONDS` seconds (default 60 s). Mutations invalidate the cache immediately, so stale windows are bounded.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `REDIS_SLOT_TTL_SECONDS` | `60` | Cache TTL for the slot list |
