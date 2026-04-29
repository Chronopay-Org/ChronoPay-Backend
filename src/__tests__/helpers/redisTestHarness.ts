/**
 * Redis test harness utilities.
 *
 * Provides:
 * - Unique key prefixes per test to prevent cross-test pollution.
 * - Automatic cleanup of all keys created during a test.
 * - Simulated Redis outage (connection error) for resilience testing.
 *
 * Usage
 * ─────
 * import { createRedisTestHarness } from "../__tests__/helpers/redisTestHarness.js";
 *
 * describe("my suite", () => {
 *   const harness = createRedisTestHarness();
 *
 *   beforeEach(() => harness.setup());
 *   afterEach(() => harness.teardown());
 *
 *   it("stores a value", async () => {
 *     const key = harness.key("mykey");
 *     await harness.client.set(key, "value", "EX", 60);
 *     expect(await harness.client.get(key)).toBe("value");
 *   });
 * });
 *
 * Security note
 * ─────────────
 * The harness never logs the REDIS_URL value; it only logs the sanitised
 * prefix so that CI logs cannot leak credentials.
 */

import { jest } from "@jest/globals";
import type { RedisClient } from "../../cache/redisClient.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RedisTestHarness {
  /** The mock Redis client injected into the module under test. */
  readonly client: jest.Mocked<RedisClient>;
  /**
   * Namespace a key with the test-unique prefix so parallel tests cannot
   * collide.
   */
  key(name: string): string;
  /** Install the mock client and reset internal state. */
  setup(): void;
  /** Remove all keys created via `key()` and reset the mock client. */
  teardown(): Promise<void>;
  /**
   * Simulate a Redis outage: all subsequent calls on the client will reject
   * with a connection error until `restoreRedis()` is called.
   */
  simulateOutage(): void;
  /** Restore normal (mock) behaviour after `simulateOutage()`. */
  restoreRedis(): void;
}

// ─── Counter for unique prefixes ──────────────────────────────────────────────
let _prefixCounter = 0;

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a new Redis test harness instance.
 *
 * Each call produces an independent harness with its own key namespace so
 * parallel test files cannot interfere with each other.
 */
export function createRedisTestHarness(): RedisTestHarness {
  const prefix = `test:${++_prefixCounter}:${Date.now()}:`;
  const trackedKeys = new Set<string>();

  // ── Build the mock client ──────────────────────────────────────────────────
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  const mockGet = jest.fn<RedisClient["get"]>().mockImplementation(async (k) => {
    const entry = store.get(k);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      store.delete(k);
      return null;
    }
    return entry.value;
  });

  const mockSet = jest
    .fn<RedisClient["set"]>()
    .mockImplementation(async (k, v, _exMode, ttl) => {
      store.set(k, {
        value: v,
        expiresAt: ttl != null ? Date.now() + (ttl as number) * 1000 : null,
      });
      return "OK";
    });

  const mockDel = jest.fn<RedisClient["del"]>().mockImplementation(async (k) => {
    const existed = store.has(k);
    store.delete(k);
    return existed ? 1 : 0;
  });

  const mockQuit = jest.fn<RedisClient["quit"]>().mockResolvedValue("OK");

  const client: jest.Mocked<RedisClient> = {
    get: mockGet,
    set: mockSet,
    del: mockDel,
    quit: mockQuit,
  };

  // ── Harness implementation ─────────────────────────────────────────────────
  return {
    get client() {
      return client;
    },

    key(name: string): string {
      const full = `${prefix}${name}`;
      trackedKeys.add(full);
      return full;
    },

    setup(): void {
      // Reset the in-memory store and all mock call histories.
      store.clear();
      trackedKeys.clear();
      jest.clearAllMocks();

      // Re-attach default implementations after clearAllMocks.
      mockGet.mockImplementation(async (k) => {
        const entry = store.get(k);
        if (!entry) return null;
        if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
          store.delete(k);
          return null;
        }
        return entry.value;
      });

      mockSet.mockImplementation(async (k, v, _exMode, ttl) => {
        store.set(k, {
          value: v,
          expiresAt: ttl != null ? Date.now() + (ttl as number) * 1000 : null,
        });
        return "OK";
      });

      mockDel.mockImplementation(async (k) => {
        const existed = store.has(k);
        store.delete(k);
        return existed ? 1 : 0;
      });

      mockQuit.mockResolvedValue("OK");
    },

    async teardown(): Promise<void> {
      // Delete all keys created via harness.key() from the in-memory store.
      for (const k of trackedKeys) {
        store.delete(k);
      }
      trackedKeys.clear();
      store.clear();
    },

    simulateOutage(): void {
      const err = new Error("Redis connection refused (simulated outage)");
      mockGet.mockRejectedValue(err);
      mockSet.mockRejectedValue(err);
      mockDel.mockRejectedValue(err);
    },

    restoreRedis(): void {
      mockGet.mockImplementation(async (k) => {
        const entry = store.get(k);
        if (!entry) return null;
        if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
          store.delete(k);
          return null;
        }
        return entry.value;
      });

      mockSet.mockImplementation(async (k, v, _exMode, ttl) => {
        store.set(k, {
          value: v,
          expiresAt: ttl != null ? Date.now() + (ttl as number) * 1000 : null,
        });
        return "OK";
      });

      mockDel.mockImplementation(async (k) => {
        const existed = store.has(k);
        store.delete(k);
        return existed ? 1 : 0;
      });
    },
  };
}
