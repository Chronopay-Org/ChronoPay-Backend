# Redis Lifecycle Management

## Overview

ChronoPay uses one shared Redis helper: `src/cache/redisClient.ts`. It backs the
slot cache, reminder deduplication, escrow listener cursors and idempotency
state, and the health/readiness probes. `src/middleware/rateLimitStore.ts` is a
separate rate-limit store.

All shared callers use the same lazy singleton. As a result,
`closeRedisClient()` on shutdown closes the same connection used by the
scheduler stores, and no second Redis socket is left open.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Full Redis connection URL. Supports `redis://` and `rediss://` (TLS). |
| `REDIS_SLOT_TTL_SECONDS` | `60` | TTL for slot cache entries. |

## Lifecycle

- `getRedisClient()` creates the client on first use outside tests.
- With `NODE_ENV=test`, no real connection is created: the helper returns the
  client injected with `setRedisClient()`, or `null` when none was injected.
- `isRedisReady()` reports whether an injected client is active. Health checks
  use `checkRedis(client)` to ping the same client.
- `closeRedisClient()` is idempotent, quits the singleton and clears it.

Connection and error events are emitted through the structured logger.

## Reconnect policy

The shared client retries with exponential backoff capped at 2 000 ms
(`min(attempt × 100 ms, 2000)`).

## Readiness check

```ts
import { isRedisReady } from "./cache/redisClient.js";

if (!isRedisReady()) {
  // Redis is not available — degrade gracefully
}
```

## Graceful shutdown

`closeRedisClient()` is registered with `ApplicationLifecycle` in `src/index.ts`,
so it runs on SIGTERM/SIGINT alongside the other shutdown steps.

## Scheduler usage

`claimDelivery`, `RedisCursorStore` and `RedisIdempotencyStore` use the shared
client from `src/cache/redisClient.ts`. They throw
`"Redis client is not available"` if no client has been configured; this makes
a missing Redis dependency explicit instead of silently skipping deduplication.

## Security notes

- **`REDIS_URL` must not be committed.** Add it to `.env` (gitignored) and
  document it in `.env.example` with a placeholder value.
- **Use TLS in production.** Prefer `rediss://` URLs when Redis is not on
  localhost or a private network.
- **Rotate credentials** using the runbook in `docs/SECRET_ROTATION_RUNBOOK.md`.

## Testing

Tests inject fakes with `setRedisClient()` and clear them with
`setRedisClient(null)`. No in-memory Redis double ships in production code.
See `src/cache/__tests__/redisClient.test.ts` and
`src/scheduler/__tests__/redisBackedStores.test.ts` for examples.
