/**
 * Tests for src/__tests__/helpers/redisTestHarness.ts
 *
 * Validates: key isolation, in-memory store behaviour, cleanup,
 * outage simulation, and restore.
 */

import { createRedisTestHarness } from "./helpers/redisTestHarness.js";

describe("createRedisTestHarness", () => {
  const harness = createRedisTestHarness();

  beforeEach(() => harness.setup());
  afterEach(() => harness.teardown());

  // ─── key() ─────────────────────────────────────────────────────────────────

  describe("key()", () => {
    it("returns a namespaced key string", () => {
      const k = harness.key("mykey");
      expect(k).toContain("mykey");
      expect(k).not.toBe("mykey"); // must be prefixed
    });

    it("returns different keys for different names", () => {
      expect(harness.key("a")).not.toBe(harness.key("b"));
    });
  });

  // ─── client.set / client.get ────────────────────────────────────────────────

  describe("client.set and client.get", () => {
    it("stores and retrieves a value", async () => {
      const k = harness.key("greeting");
      await harness.client.set(k, "hello", "EX", 60);
      expect(await harness.client.get(k)).toBe("hello");
    });

    it("returns null for a missing key", async () => {
      expect(await harness.client.get(harness.key("missing"))).toBeNull();
    });

    it("overwrites an existing value", async () => {
      const k = harness.key("val");
      await harness.client.set(k, "first", "EX", 60);
      await harness.client.set(k, "second", "EX", 60);
      expect(await harness.client.get(k)).toBe("second");
    });
  });

  // ─── client.del ─────────────────────────────────────────────────────────────

  describe("client.del", () => {
    it("removes a key and returns 1", async () => {
      const k = harness.key("todel");
      await harness.client.set(k, "x", "EX", 60);
      const result = await harness.client.del(k);
      expect(result).toBe(1);
      expect(await harness.client.get(k)).toBeNull();
    });

    it("returns 0 for a non-existent key", async () => {
      const result = await harness.client.del(harness.key("ghost"));
      expect(result).toBe(0);
    });
  });

  // ─── teardown() ─────────────────────────────────────────────────────────────

  describe("teardown()", () => {
    it("clears all tracked keys", async () => {
      const k = harness.key("cleanup");
      await harness.client.set(k, "data", "EX", 60);

      await harness.teardown();

      // After teardown the store is cleared; re-setup to use client again
      harness.setup();
      expect(await harness.client.get(k)).toBeNull();
    });
  });

  // ─── setup() ────────────────────────────────────────────────────────────────

  describe("setup()", () => {
    it("resets mock call counts", async () => {
      await harness.client.get(harness.key("x"));
      harness.setup();
      expect(harness.client.get).toHaveBeenCalledTimes(0);
    });

    it("clears the in-memory store", async () => {
      const k = harness.key("persist");
      await harness.client.set(k, "v", "EX", 60);
      harness.setup();
      expect(await harness.client.get(k)).toBeNull();
    });
  });

  // ─── simulateOutage / restoreRedis ──────────────────────────────────────────

  describe("simulateOutage()", () => {
    it("makes get() reject with a connection error", async () => {
      harness.simulateOutage();
      await expect(harness.client.get(harness.key("k"))).rejects.toThrow(
        /simulated outage/i,
      );
    });

    it("makes set() reject with a connection error", async () => {
      harness.simulateOutage();
      await expect(
        harness.client.set(harness.key("k"), "v", "EX", 60),
      ).rejects.toThrow(/simulated outage/i);
    });

    it("makes del() reject with a connection error", async () => {
      harness.simulateOutage();
      await expect(harness.client.del(harness.key("k"))).rejects.toThrow(
        /simulated outage/i,
      );
    });
  });

  describe("restoreRedis()", () => {
    it("restores normal behaviour after an outage", async () => {
      harness.simulateOutage();
      harness.restoreRedis();

      const k = harness.key("restored");
      await harness.client.set(k, "ok", "EX", 60);
      expect(await harness.client.get(k)).toBe("ok");
    });
  });

  // ─── Parallel isolation ──────────────────────────────────────────────────────

  describe("parallel isolation", () => {
    it("two harnesses do not share keys", async () => {
      const h2 = createRedisTestHarness();
      h2.setup();

      const k1 = harness.key("shared-name");
      const k2 = h2.key("shared-name");

      await harness.client.set(k1, "from-h1", "EX", 60);
      await h2.client.set(k2, "from-h2", "EX", 60);

      // Each harness has its own store; they cannot see each other's data
      expect(await harness.client.get(k1)).toBe("from-h1");
      expect(await h2.client.get(k2)).toBe("from-h2");

      // The keys themselves are different strings
      expect(k1).not.toBe(k2);

      await h2.teardown();
    });
  });
});
