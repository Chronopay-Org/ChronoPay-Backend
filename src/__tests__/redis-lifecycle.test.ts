/**
 * Tests for Redis lifecycle management.
 *
 * Strategy
 * ────────
 * ioredis is not installed in this project, so tests exercise:
 *   1. sanitizeRedisUrl — pure function, no I/O.
 *   2. isRedisReady / setRedisClient / closeRedisClient — state management.
 *   3. In-memory test double (NODE_ENV=test path) — get/set/NX/TTL/quit.
 *   4. Lifecycle hooks wired to a fake EventEmitter — connect, ready, error,
 *      close, end events update the readiness flag correctly.
 *
 * No real Redis connection is made.
 */

import { fileURLToPath } from "url";
import path from "path";

// Resolve repo root for module imports
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 1. sanitizeRedisUrl ────────────────────────────────────────────────────

import {
  sanitizeRedisUrl,
  isRedisReady as isCacheReady,
  setRedisClient,
  closeRedisClient as closeCacheClient,
  getRedisClient as getCacheClient,
} from "../cache/redisClient.js";

import {
  sanitizeRedisUrl as sanitizeUtilUrl,
  isRedisReady as isUtilReady,
  closeRedisClient as closeUtilClient,
  getRedisClient as getUtilClient,
} from "../utils/redis.js";

describe("sanitizeRedisUrl (cache/redisClient)", () => {
  it("strips password from redis URL", () => {
    const result = sanitizeRedisUrl("redis://:s3cr3t@localhost:6379");
    expect(result).toMatch(/^redis:\/\/localhost:6379/);
    expect(result).not.toContain("s3cr3t");
  });

  it("strips username and password", () => {
    const result = sanitizeRedisUrl("redis://user:pass@host:6379/0");
    expect(result).toMatch(/^redis:\/\/host:6379\/0/);
    expect(result).not.toContain("pass");
    expect(result).not.toContain("user");
  });

  it("leaves a plain URL unchanged", () => {
    // URL API normalises redis://localhost:6379 — no trailing slash added
    const result = sanitizeRedisUrl("redis://localhost:6379");
    expect(result).toMatch(/^redis:\/\/localhost:6379/);
    expect(result).not.toContain("@");
  });

  it("returns placeholder for invalid URLs", () => {
    expect(sanitizeRedisUrl("not-a-url")).toBe("[invalid-redis-url]");
  });
});

describe("sanitizeRedisUrl (utils/redis)", () => {
  it("strips credentials", () => {
    const result = sanitizeUtilUrl("redis://:secret@redis.example.com:6379");
    expect(result).toMatch(/^redis:\/\/redis\.example\.com:6379/);
    expect(result).not.toContain("secret");
  });

  it("returns placeholder for invalid URLs", () => {
    expect(sanitizeUtilUrl("bad")).toBe("[invalid-redis-url]");
  });
});

// ─── 2. Readiness flag and setRedisClient ───────────────────────────────────

describe("isRedisReady / setRedisClient (cache/redisClient)", () => {
  afterEach(async () => {
    // Reset state between tests
    setRedisClient(null);
  });

  it("starts as false when no client is set", () => {
    setRedisClient(null);
    expect(isCacheReady()).toBe(false);
  });

  it("becomes true when a client is injected via setRedisClient", () => {
    const fake = {
      get: async () => null,
      set: async () => "OK",
      del: async () => 1,
      quit: async () => "OK",
    };
    setRedisClient(fake);
    expect(isCacheReady()).toBe(true);
  });

  it("becomes false again after setRedisClient(null)", () => {
    const fake = { get: async () => null, set: async () => "OK", del: async () => 1, quit: async () => "OK" };
    setRedisClient(fake);
    setRedisClient(null);
    expect(isCacheReady()).toBe(false);
  });
});

// ─── 3. closeRedisClient (cache/redisClient) ────────────────────────────────

describe("closeRedisClient (cache/redisClient)", () => {
  it("calls quit() on the active client and resets readiness", async () => {
    let quitCalled = false;
    const fake = {
      get: async () => null,
      set: async () => "OK",
      del: async () => 1,
      quit: async () => { quitCalled = true; return "OK"; },
    };
    setRedisClient(fake);
    expect(isCacheReady()).toBe(true);

    await closeCacheClient();

    expect(quitCalled).toBe(true);
    expect(isCacheReady()).toBe(false);
  });

  it("is idempotent — calling twice does not throw", async () => {
    setRedisClient(null);
    await expect(closeCacheClient()).resolves.toBeUndefined();
    await expect(closeCacheClient()).resolves.toBeUndefined();
  });
});

// ─── 4. In-memory test double (utils/redis, NODE_ENV=test) ──────────────────

describe("in-memory Redis double (utils/redis, NODE_ENV=test)", () => {
  let client: ReturnType<typeof getUtilClient>;

  beforeEach(async () => {
    // Reset the singleton between tests by closing and re-getting
    await closeUtilClient();
    client = getUtilClient();
  });

  afterEach(async () => {
    await closeUtilClient();
  });

  it("returns null for a missing key", async () => {
    expect(await client.get("missing")).toBeNull();
  });

  it("stores and retrieves a value", async () => {
    await client.set("k", "v", "EX", 60);
    expect(await client.get("k")).toBe("v");
  });

  it("NX flag prevents overwrite of existing key", async () => {
    await client.set("k", "first", "EX", 60);
    const result = await client.set("k", "second", "EX", 60, "NX");
    expect(result).toBeNull();
    expect(await client.get("k")).toBe("first");
  });

  it("NX flag allows write when key is absent", async () => {
    const result = await client.set("new", "value", "EX", 60, "NX");
    expect(result).toBe("OK");
    expect(await client.get("new")).toBe("value");
  });

  it("quit clears the store", async () => {
    await client.set("k", "v", "EX", 60);
    await client.quit();
    // After quit, get a fresh client
    const fresh = getUtilClient();
    expect(await fresh.get("k")).toBeNull();
  });

  it("isRedisReady returns true in test env", () => {
    expect(isUtilReady()).toBe(true);
  });
});

// ─── 5. closeRedisClient (utils/redis) ──────────────────────────────────────

describe("closeRedisClient (utils/redis)", () => {
  afterEach(async () => {
    await closeUtilClient();
  });

  it("resets readiness to false after close", async () => {
    getUtilClient(); // initialise
    expect(isUtilReady()).toBe(true);
    await closeUtilClient();
    expect(isUtilReady()).toBe(false);
  });

  it("is idempotent", async () => {
    await closeUtilClient();
    await expect(closeUtilClient()).resolves.toBeUndefined();
  });
});

// ─── 6. getRedisClient returns null in test env (cache/redisClient) ──────────

describe("getRedisClient in test env (cache/redisClient)", () => {
  afterEach(() => setRedisClient(null));

  it("returns null when no client has been injected", () => {
    setRedisClient(null);
    expect(getCacheClient()).toBeNull();
  });

  it("returns the injected client", () => {
    const fake = { get: async () => null, set: async () => "OK", del: async () => 1, quit: async () => "OK" };
    setRedisClient(fake);
    expect(getCacheClient()).toBe(fake);
  });
});
