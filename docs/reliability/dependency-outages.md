# Dependency Outage Handling

This document describes how ChronoPay handles Redis and database outages consistently and safely.

## Overview

When a required dependency (Redis or PostgreSQL) is unavailable, the API fails **closed** — it returns a deterministic `503 Service Unavailable` response rather than silently degrading or allowing unsafe partial processing.

## 503 Payload Shape

All dependency-outage responses use the same envelope:

```json
{
  "success": false,
  "code": "DEPENDENCY_UNAVAILABLE",
  "error": "<dependency> is currently unavailable"
}
```

This matches the existing `FEATURE_DISABLED` envelope shape used by feature flags, giving clients a single consistent pattern to handle.

## Components

### `src/middleware/dependencyStatus.ts`

Centralized status provider. Exposes one function:

```ts
isDependencyAvailable(dep: "redis" | "db"): Promise<boolean>
```

- **redis** — delegates to `isRedisReady()` from `src/cache/redisClient.ts` (synchronous flag set by lifecycle events).
- **db** — runs a lightweight `SELECT 1` probe against the pool. The probe is injectable via `_setDbReadyProbe()` for tests.

Internal connection strings and error details are never surfaced to callers.

### `src/middleware/requireDependency.ts`

Middleware factory for route-level dependency guards:

```ts
router.post("/api/v1/slots", requireDependency("redis"), handler);
```

Returns `503 DEPENDENCY_UNAVAILABLE` immediately if the dependency is down; calls `next()` otherwise.

### `src/middleware/idempotency.ts` (updated)

Previously passed through (`next()`) when Redis was unavailable. Now **fails closed**: if the Redis client is `null` and an `Idempotency-Key` header is present, the middleware returns `503 DEPENDENCY_UNAVAILABLE` without calling `next()`.

Rationale: without Redis, idempotency guarantees cannot be upheld. Allowing the request through would risk duplicate processing of financial operations.

### `src/middleware/errorHandling.ts` (updated)

`genericErrorHandler` now emits the consistent `{ success, code, error }` envelope for **any** `AppError`-shaped error (i.e., any `Error` with `statusCode` and `code` properties). Previously only `415`/`406` errors were handled this way.

## Behavior by Scenario

| Scenario | Endpoint behavior |
|---|---|
| Redis down, `Idempotency-Key` present | `503 DEPENDENCY_UNAVAILABLE` |
| Redis down, no `Idempotency-Key` | Request proceeds normally (idempotency is opt-in) |
| DB down, route guarded with `requireDependency("db")` | `503 DEPENDENCY_UNAVAILABLE` |
| Both down, route guarded with `requireDependency("redis")` | `503 DEPENDENCY_UNAVAILABLE` (Redis checked first) |
| `ServiceUnavailableError` thrown and caught by `genericErrorHandler` | `503 SERVICE_UNAVAILABLE` with consistent envelope |

## Security Notes

- Error responses never include connection strings, hostnames, credentials, or stack traces.
- The dependency name in the error message is a static label (`"Redis"` / `"Database"`), not derived from any runtime value.
- The `_setDbReadyProbe()` and `_setDbReadyProbe()` escape hatches are marked `@internal` and are only used in tests — they are not exported from any public barrel.

## Testing

Tests live in `src/__tests__/dependency-outage.test.ts` and cover:

- `isDependencyAvailable` with Redis up/down and DB up/down
- `requireDependency` middleware: 503 when down, pass-through when up, partial outage (redis down + db up)
- Idempotency fail-closed: 503 returned, `next()` not called
- `genericErrorHandler`: consistent envelope for `ServiceUnavailableError`, generic AppError-shaped errors, and regression for `415`/`406`

Run with:

```bash
npm test -- --testPathPattern dependency-outage
```
