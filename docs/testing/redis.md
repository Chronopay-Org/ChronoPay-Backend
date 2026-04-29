# Redis Test Harness

Shared test utilities for Redis-dependent tests with per-test key isolation and cleanup.

## Location

`src/__tests__/helpers/redisTestHarness.ts`

## Why

Tests that exercise Redis-dependent code (idempotency middleware, slot cache) need:

- **Isolation** — keys from one test must not bleed into another, even when tests run in parallel.
- **Cleanup** — all keys created during a test must be removed in `afterEach`.
- **Outage simulation** — resilience paths (cache bypass, graceful degradation) must be testable without a real Redis instance.
- **No real Redis** — CI environments may not have Redis; the harness uses an in-memory mock.

## Usage

```ts
import { createRedisTestHarness } from "../__tests__/helpers/redisTestHarness.js";

describe("my suite", () => {
  const harness = createRedisTestHarness();

  beforeEach(() => harness.setup());
  afterEach(() => harness.teardown());

  it("stores a value", async () => {
    const key = harness.key("mykey");
    await harness.client.set(key, "value", "EX", 60);
    expect(await harness.client.get(key)).toBe("value");
  });

  it("handles Redis outage gracefully", async () => {
    harness.simulateOutage();
    await expect(harness.client.get(harness.key("k"))).rejects.toThrow(/simulated outage/i);
    harness.restoreRedis();
  });
});
```

## API

| Method | Description |
|---|---|
| `harness.key(name)` | Returns a namespaced key unique to this harness instance. Tracks the key for cleanup. |
| `harness.setup()` | Resets the in-memory store and all mock call histories. Call in `beforeEach`. |
| `harness.teardown()` | Deletes all tracked keys and clears the store. Call in `afterEach`. |
| `harness.simulateOutage()` | Makes all client methods reject with a connection error. |
| `harness.restoreRedis()` | Restores normal mock behaviour after `simulateOutage()`. |
| `harness.client` | The `jest.Mocked<RedisClient>` instance to inject into the module under test. |

## Parallel isolation

Each `createRedisTestHarness()` call produces an independent harness with its own in-memory store and unique key prefix. Two harnesses running in parallel cannot see each other's data.

## Security notes

- The harness never logs the `REDIS_URL` value; only the sanitised key prefix is used internally.
- The mock client does not make any network connections.
- TTL expiry is simulated using `Date.now()` comparisons in the mock implementation.

## Test coverage

`src/__tests__/redisTestHarness.test.ts` covers key isolation, store operations, cleanup, outage simulation, restore, and parallel harness independence.
