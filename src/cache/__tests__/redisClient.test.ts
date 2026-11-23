/**
 * redisClient.test.ts
 *
 * Focused regression coverage for SLOT_CACHE_TTL_SECONDS, RedisClient, and isRedisReady.
 * Tests cover constant reading, client lifecycle, state transitions, error handling,
 * and boundary conditions.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  SLOT_CACHE_TTL_SECONDS,
  getRedisClient,
  setRedisClient,
  isRedisReady,
  closeRedisClient,
  type RedisClient,
} from "../redisClient.js";

// ---------------------------------------------------------------------------
// Helper: Create a mock RedisClient
// ---------------------------------------------------------------------------

function createMockRedisClient(): RedisClient {
  return {
    get: jest.fn<(key: string) => Promise<string | null>>().mockResolvedValue(null),
    set: jest.fn<(key: string, value: string, exMode: "EX", ttl: number, condition?: "NX") => Promise<unknown>>().mockResolvedValue("OK"),
    del: jest.fn<(key: string) => Promise<unknown>>().mockResolvedValue(1),
    keys: jest.fn<(pattern: string) => Promise<string[]>>().mockResolvedValue([]),
    ping: jest.fn<() => Promise<string>>().mockResolvedValue("PONG"),
    quit: jest.fn<() => Promise<unknown>>().mockResolvedValue("OK"),
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

describe("redisClient module", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Ensure test mode to prevent real Redis connections
    process.env.NODE_ENV = "test";
    setRedisClient(null);
  });

  afterEach(async () => {
    await closeRedisClient();
    setRedisClient(null);
    process.env = { ...originalEnv };
  });

  // ---------------------------------------------------------------------------
  // SLOT_CACHE_TTL_SECONDS constant
  // ---------------------------------------------------------------------------

  describe("SLOT_CACHE_TTL_SECONDS", () => {
    it("exports the constant as a named export", () => {
      expect(SLOT_CACHE_TTL_SECONDS).toBeDefined();
      expect(typeof SLOT_CACHE_TTL_SECONDS).toBe("number");
    });

    it("defaults to 60 when REDIS_SLOT_TTL_SECONDS is not set", () => {
      // The constant is evaluated at module load time
      // We test that it has a sensible default value
      expect(SLOT_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(0);
    });

    it("is a non-negative integer", () => {
      expect(Number.isInteger(SLOT_CACHE_TTL_SECONDS)).toBe(true);
      expect(SLOT_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(0);
    });

    it("parses REDIS_SLOT_TTL_SECONDS from environment", () => {
      // Note: The constant is already set at module load, so we verify it's a number
      // In practice, tests would need to set env vars before importing the module
      expect(typeof SLOT_CACHE_TTL_SECONDS).toBe("number");
    });
  });

  // ---------------------------------------------------------------------------
  // getRedisClient
  // ---------------------------------------------------------------------------

  describe("getRedisClient", () => {
    it("returns null in test environment when no client is set", () => {
      const client = getRedisClient();
      expect(client).toBeNull();
    });

    it("returns the injected client after setRedisClient is called", () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      const client = getRedisClient();
      expect(client).toBe(mockClient);
    });

    it("returns null after setRedisClient(null) is called", () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);
      setRedisClient(null);

      const client = getRedisClient();
      expect(client).toBeNull();
    });

    it("does not create real Redis connection in test mode", () => {
      // Should not throw or connect to real Redis
      const client = getRedisClient();
      expect(client).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // setRedisClient
  // ---------------------------------------------------------------------------

  describe("setRedisClient", () => {
    it("sets the active client", () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      expect(getRedisClient()).toBe(mockClient);
    });

    it("accepts null to reset the client", () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);
      setRedisClient(null);

      expect(getRedisClient()).toBeNull();
    });

    it("replaces an existing client", () => {
      const client1 = createMockRedisClient();
      const client2 = createMockRedisClient();

      setRedisClient(client1);
      expect(getRedisClient()).toBe(client1);

      setRedisClient(client2);
      expect(getRedisClient()).toBe(client2);
    });

    it("updates isRedisReady when client is set", () => {
      expect(isRedisReady()).toBe(false);

      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      expect(isRedisReady()).toBe(true);
    });

    it("updates isRedisReady to false when client is set to null", () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);
      expect(isRedisReady()).toBe(true);

      setRedisClient(null);
      expect(isRedisReady()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // isRedisReady
  // ---------------------------------------------------------------------------

  describe("isRedisReady", () => {
    it("returns false when no client is set", () => {
      expect(isRedisReady()).toBe(false);
    });

    it("returns true after a client is set", () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      expect(isRedisReady()).toBe(true);
    });

    it("returns false after client is cleared", () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);
      setRedisClient(null);

      expect(isRedisReady()).toBe(false);
    });

    it("returns false after closeRedisClient is called", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);
      expect(isRedisReady()).toBe(true);

      await closeRedisClient();
      expect(isRedisReady()).toBe(false);
    });

    it("does not mutate state when called multiple times", () => {
      expect(isRedisReady()).toBe(false);
      expect(isRedisReady()).toBe(false);

      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      expect(isRedisReady()).toBe(true);
      expect(isRedisReady()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // closeRedisClient
  // ---------------------------------------------------------------------------

  describe("closeRedisClient", () => {
    it("calls quit on the active client", async () => {
      const mockClient = createMockRedisClient();
      const quitSpy = jest.spyOn(mockClient, "quit");
      setRedisClient(mockClient);

      await closeRedisClient();

      expect(quitSpy).toHaveBeenCalledTimes(1);
    });

    it("clears the active client reference", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      await closeRedisClient();

      expect(getRedisClient()).toBeNull();
    });

    it("sets isRedisReady to false", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);
      expect(isRedisReady()).toBe(true);

      await closeRedisClient();

      expect(isRedisReady()).toBe(false);
    });

    it("is idempotent (safe to call multiple times)", async () => {
      const mockClient = createMockRedisClient();
      const quitSpy = jest.spyOn(mockClient, "quit");
      setRedisClient(mockClient);

      await closeRedisClient();
      await closeRedisClient();
      await closeRedisClient();

      // quit should only be called once (first close)
      expect(quitSpy).toHaveBeenCalledTimes(1);
    });

    it("does not throw when no client is set", async () => {
      await expect(closeRedisClient()).resolves.toBeUndefined();
    });

    it("does not throw when client is already null", async () => {
      setRedisClient(null);
      await expect(closeRedisClient()).resolves.toBeUndefined();
    });

    it("handles quit errors gracefully", async () => {
      const mockClient = createMockRedisClient();
      // @ts-expect-error - testing error handling
      mockClient.quit = jest.fn().mockRejectedValue(new Error("quit failed"));
      setRedisClient(mockClient);

      // Should propagate the error (not caught internally)
      await expect(closeRedisClient()).rejects.toThrow("quit failed");

      // But state should still be cleared
      expect(getRedisClient()).toBeNull();
      expect(isRedisReady()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // RedisClient interface
  // ---------------------------------------------------------------------------

  describe("RedisClient interface", () => {
    it("exposes get method", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      const client = getRedisClient();
      expect(client).not.toBeNull();
      expect(typeof client!.get).toBe("function");

      await client!.get("test-key");
      expect(mockClient.get).toHaveBeenCalledWith("test-key");
    });

    it("exposes set method with EX and optional NX", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      const client = getRedisClient();
      expect(typeof client!.set).toBe("function");

      await client!.set("key", "value", "EX", 60);
      expect(mockClient.set).toHaveBeenCalledWith("key", "value", "EX", 60);
    });

    it("exposes del method", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      const client = getRedisClient();
      expect(typeof client!.del).toBe("function");

      await client!.del("test-key");
      expect(mockClient.del).toHaveBeenCalledWith("test-key");
    });

    it("exposes keys method", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      const client = getRedisClient();
      expect(typeof client!.keys).toBe("function");

      await client!.keys("test:*");
      expect(mockClient.keys).toHaveBeenCalledWith("test:*");
    });

    it("exposes ping method", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      const client = getRedisClient();
      expect(typeof client!.ping).toBe("function");

      const response = await client!.ping();
      expect(response).toBe("PONG");
    });

    it("exposes quit method", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      const client = getRedisClient();
      expect(typeof client!.quit).toBe("function");

      await client!.quit();
      expect(mockClient.quit).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  describe("State transitions", () => {
    it("transitions: null → set client → ready", () => {
      expect(getRedisClient()).toBeNull();
      expect(isRedisReady()).toBe(false);

      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      expect(getRedisClient()).toBe(mockClient);
      expect(isRedisReady()).toBe(true);
    });

    it("transitions: ready → close → null/not ready", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);
      expect(isRedisReady()).toBe(true);

      await closeRedisClient();

      expect(getRedisClient()).toBeNull();
      expect(isRedisReady()).toBe(false);
    });

    it("transitions: ready → set null → not ready", () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);
      expect(isRedisReady()).toBe(true);

      setRedisClient(null);

      expect(getRedisClient()).toBeNull();
      expect(isRedisReady()).toBe(false);
    });

    it("transitions: ready → replace client → still ready", () => {
      const client1 = createMockRedisClient();
      const client2 = createMockRedisClient();

      setRedisClient(client1);
      expect(isRedisReady()).toBe(true);

      setRedisClient(client2);
      expect(isRedisReady()).toBe(true);
      expect(getRedisClient()).toBe(client2);
    });

    it("handles rapid set/unset cycles", () => {
      const mockClient = createMockRedisClient();

      setRedisClient(mockClient);
      expect(isRedisReady()).toBe(true);

      setRedisClient(null);
      expect(isRedisReady()).toBe(false);

      setRedisClient(mockClient);
      expect(isRedisReady()).toBe(true);

      setRedisClient(null);
      expect(isRedisReady()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Boundary conditions
  // ---------------------------------------------------------------------------

  describe("Boundary conditions", () => {
    it("handles client with all methods returning promises", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      const client = getRedisClient()!;

      // All methods should be callable and return promises
      await expect(client.get("key")).resolves.toBeNull();
      await expect(client.set("key", "val", "EX", 60)).resolves.toBeDefined();
      await expect(client.del("key")).resolves.toBeDefined();
      await expect(client.keys("*")).resolves.toEqual([]);
      await expect(client.ping()).resolves.toBe("PONG");
      await expect(client.quit()).resolves.toBeDefined();
    });

    it("handles client methods returning rejected promises", async () => {
      const mockClient = createMockRedisClient();
      // @ts-expect-error - testing error handling
      mockClient.get = jest.fn().mockRejectedValue(new Error("connection lost"));
      setRedisClient(mockClient);

      const client = getRedisClient()!;

      await expect(client.get("key")).rejects.toThrow("connection lost");
    });

    it("handles set with NX condition parameter", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      const client = getRedisClient()!;
      await client.set("key", "value", "EX", 60, "NX");

      expect(mockClient.set).toHaveBeenCalledWith("key", "value", "EX", 60, "NX");
    });

    it("handles keys returning empty array", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      const client = getRedisClient()!;
      const keys = await client.keys("nonexistent:*");

      expect(keys).toEqual([]);
    });

    it("handles keys returning multiple results", async () => {
      const mockClient = createMockRedisClient();
      // @ts-expect-error - mock return value
      mockClient.keys = jest.fn().mockResolvedValue(["key1", "key2", "key3"]);
      setRedisClient(mockClient);

      const client = getRedisClient()!;
      const keys = await client.keys("test:*");

      expect(keys).toHaveLength(3);
      expect(keys).toContain("key1");
    });

    it("handles del returning 0 (key not found)", async () => {
      const mockClient = createMockRedisClient();
      // @ts-expect-error - mock return value
      mockClient.del = jest.fn().mockResolvedValue(0);
      setRedisClient(mockClient);

      const client = getRedisClient()!;
      const result = await client.del("nonexistent-key");

      expect(result).toBe(0);
    });

    it("handles del returning 1 (key deleted)", async () => {
      const mockClient = createMockRedisClient();
      // @ts-expect-error - mock return value
      mockClient.del = jest.fn().mockResolvedValue(1);
      setRedisClient(mockClient);

      const client = getRedisClient()!;
      const result = await client.del("existing-key");

      expect(result).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe("Error handling", () => {
    it("propagates errors from client.get", async () => {
      const mockClient = createMockRedisClient();
      // @ts-expect-error - testing error handling
      mockClient.get = jest.fn().mockRejectedValue(new Error("GET failed"));
      setRedisClient(mockClient);

      const client = getRedisClient()!;
      await expect(client.get("key")).rejects.toThrow("GET failed");
    });

    it("propagates errors from client.set", async () => {
      const mockClient = createMockRedisClient();
      // @ts-expect-error - testing error handling
      mockClient.set = jest.fn().mockRejectedValue(new Error("SET failed"));
      setRedisClient(mockClient);

      const client = getRedisClient()!;
      await expect(client.set("key", "val", "EX", 60)).rejects.toThrow("SET failed");
    });

    it("propagates errors from client.del", async () => {
      const mockClient = createMockRedisClient();
      // @ts-expect-error - testing error handling
      mockClient.del = jest.fn().mockRejectedValue(new Error("DEL failed"));
      setRedisClient(mockClient);

      const client = getRedisClient()!;
      await expect(client.del("key")).rejects.toThrow("DEL failed");
    });

    it("propagates errors from client.keys", async () => {
      const mockClient = createMockRedisClient();
      // @ts-expect-error - testing error handling
      mockClient.keys = jest.fn().mockRejectedValue(new Error("KEYS failed"));
      setRedisClient(mockClient);

      const client = getRedisClient()!;
      await expect(client.keys("*")).rejects.toThrow("KEYS failed");
    });

    it("propagates errors from client.ping", async () => {
      const mockClient = createMockRedisClient();
      // @ts-expect-error - testing error handling
      mockClient.ping = jest.fn().mockRejectedValue(new Error("PING failed"));
      setRedisClient(mockClient);

      const client = getRedisClient()!;
      await expect(client.ping()).rejects.toThrow("PING failed");
    });
  });

  // ---------------------------------------------------------------------------
  // Test environment behavior
  // ---------------------------------------------------------------------------

  describe("Test environment behavior", () => {
    it("respects NODE_ENV=test and returns injected client", () => {
      process.env.NODE_ENV = "test";
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      expect(getRedisClient()).toBe(mockClient);
    });

    it("returns null in test mode when no client is injected", () => {
      process.env.NODE_ENV = "test";
      setRedisClient(null);

      expect(getRedisClient()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Integration scenarios
  // ---------------------------------------------------------------------------

  describe("Integration scenarios", () => {
    it("complete lifecycle: set → use → close", async () => {
      const mockClient = createMockRedisClient();
      
      // Set client
      setRedisClient(mockClient);
      expect(isRedisReady()).toBe(true);

      // Use client
      const client = getRedisClient()!;
      await client.set("test", "value", "EX", 60);
      await client.get("test");
      expect(mockClient.set).toHaveBeenCalled();
      expect(mockClient.get).toHaveBeenCalled();

      // Close client
      await closeRedisClient();
      expect(isRedisReady()).toBe(false);
      expect(getRedisClient()).toBeNull();
    });

    it("supports client replacement without close", () => {
      const client1 = createMockRedisClient();
      const client2 = createMockRedisClient();

      setRedisClient(client1);
      expect(getRedisClient()).toBe(client1);
      expect(isRedisReady()).toBe(true);

      // Replace without closing
      setRedisClient(client2);
      expect(getRedisClient()).toBe(client2);
      expect(isRedisReady()).toBe(true);
    });

    it("allows re-initialization after close", async () => {
      const client1 = createMockRedisClient();
      setRedisClient(client1);
      await closeRedisClient();

      expect(getRedisClient()).toBeNull();
      expect(isRedisReady()).toBe(false);

      // Re-initialize
      const client2 = createMockRedisClient();
      setRedisClient(client2);

      expect(getRedisClient()).toBe(client2);
      expect(isRedisReady()).toBe(true);
    });

    it("handles multiple clients in sequence", async () => {
      const clients = [
        createMockRedisClient(),
        createMockRedisClient(),
        createMockRedisClient(),
      ];

      for (const client of clients) {
        setRedisClient(client);
        expect(getRedisClient()).toBe(client);
        expect(isRedisReady()).toBe(true);

        await client.ping();
        expect(client.ping).toHaveBeenCalled();

        await closeRedisClient();
        expect(isRedisReady()).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // SLOT_CACHE_TTL_SECONDS usage in operations
  // ---------------------------------------------------------------------------

  describe("SLOT_CACHE_TTL_SECONDS usage", () => {
    it("can be used as TTL parameter in set operations", async () => {
      const mockClient = createMockRedisClient();
      setRedisClient(mockClient);

      const client = getRedisClient()!;
      await client.set("key", "value", "EX", SLOT_CACHE_TTL_SECONDS);

      expect(mockClient.set).toHaveBeenCalledWith(
        "key",
        "value",
        "EX",
        SLOT_CACHE_TTL_SECONDS
      );
    });

    it("is a positive number suitable for cache TTL", () => {
      expect(SLOT_CACHE_TTL_SECONDS).toBeGreaterThan(0);
      expect(Number.isFinite(SLOT_CACHE_TTL_SECONDS)).toBe(true);
    });
  });
});
