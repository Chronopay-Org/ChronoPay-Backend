# Redis Lifecycle Management

## Overview

ChronoPay uses Redis for two purposes:

- **Idempotency key storage** (`src/utils/redis.ts`) — used by the idempotency middleware on mutating endpoints.
- **Slot cache** (`src/cache/redisClient.ts`) — used by `slotCache.ts` to cache slot list responses.

Both modules share the same lifecycle design: a lazy singleton with structured lifecycle logging, exponential backoff reconnect, a readiness flag, and an idempotent shutdown function.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Full Redis connection URL. Supports `redis://`, `rediss://` (TLS), and `redis://:password@host:port` formats. |
| `REDIS_SLOT_TTL_SECONDS` | `60` | TTL for slot cache entries. |

## Lifecycle events

| Event | Meaning | Action taken |
|---|---|---|
| `connect` | TCP connection established | Logged at `info` |
| `ready` | Server responded to PING — commands accepted | `isRedisReady()` → `true`; logged at `info` |
| `error` | Connection or command error | Logged at `error` (message only, no URL credentials) |
| `close` | Connection dropped | `isRedisReady()` → `false`; logged at `warn` |
| `reconnecting` | Backoff delay started | Logged at `warn` with attempt count and delay |
| `end` | All retries exhausted — no further reconnects | `isRedisReady()` → `false`; logged at `warn` |

## Reconnect policy

Exponential backoff: `delay = min(attempt × 100 ms, cap)`.

| Module | Cap | Max attempts |
|---|---|---|
| `src/cache/redisClient.ts` | 2 000 ms | 10 |
| `src/utils/redis.ts` | 3 000 ms | 10 |

After the maximum attempts the client stops retrying and logs an error. The application continues running — cache misses fall through to the origin and idempotency checks are skipped.

## Readiness check

```ts
import { isRedisReady } from "./utils/redis.js";

if (!isRedisReady()) {
  // Redis is not available — degrade gracefully
}
```

Use this in health check endpoints or startup probes to distinguish "Redis unavailable" from "application unhealthy".

## Graceful shutdown

`closeRedisClient()` is called automatically from the SIGTERM and SIGINT handlers in `src/index.ts`:

```
SIGTERM / SIGINT
  → server.close()        (stop accepting new requests)
  → closeRedisClient()    (QUIT command, then null the singleton)
  → process.exit(0)
```

`closeRedisClient()` is idempotent — calling it multiple times is safe.

## Security notes

- **Credentials are never logged.** The connection URL is passed through `sanitizeRedisUrl()` before any log line is emitted. `redis://:password@host:6379` becomes `redis://host:6379/`.
- **`REDIS_URL` must not be committed.** Add it to `.env` (gitignored) and document it in `.env.example` with a placeholder value.
- **Use TLS in production.** Prefer `rediss://` URLs when Redis is not on localhost or a private network.
- **Rotate credentials** using the runbook in `docs/SECRET_ROTATION_RUNBOOK.md`.

## Testing

The test environment (`NODE_ENV=test`) uses an in-memory double that satisfies the same interface without requiring a real Redis server. TTL expiry is simulated using wall-clock time.

Tests that exercise lifecycle behaviour mock the ioredis constructor and event emitter directly — see `src/__tests__/redis-lifecycle.test.ts`.
