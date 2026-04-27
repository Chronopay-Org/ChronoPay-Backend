# Cache Invalidation Strategy

## Scope

This strategy applies to the in-process slot listing cache used by the ChronoPay backend.

## Behavior

- `GET /api/v1/slots` uses a process-local in-memory cache with a `30s` TTL.
- `POST /api/v1/slots` invalidates every key prefixed with `slots:list` immediately after a successful write.
- API responses set `Cache-Control: no-store` so browsers and intermediaries do not cache mutable scheduling data.

## Acceptance Criteria

- Repeated slot-list reads return cached data until the TTL expires.
- Any successful slot creation invalidates the list cache before the next read.
- Invalid slot payloads never mutate state or poison the cache.
- Cache storage is bounded to avoid unbounded memory growth.

## Failure Modes

- Expired entries are treated as cache misses and recomputed.
- Invalid payloads return `400` and skip invalidation because no write occurred.
- This implementation is process-local, so it does not synchronize across multiple backend instances.

## Security Notes

- The backend is authoritative; clients are explicitly prevented from caching slot data.
- Returned slot arrays are cloned before they leave the service to avoid accidental mutation of cached state.
- Numeric time bounds are validated to prevent reversed or malformed intervals from entering the store.