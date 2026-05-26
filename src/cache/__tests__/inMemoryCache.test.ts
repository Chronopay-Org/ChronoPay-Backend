import { jest } from "@jest/globals";
import { InMemoryCache } from "../inMemoryCache.js";

const TTL = 1000;

describe("InMemoryCache", () => {
  let now: number;
  let cache: InMemoryCache<string>;

  beforeEach(() => {
    now = 0;
    cache = new InMemoryCache({ ttlMs: TTL, clock: () => now });
  });

  // ── constructor validation ──────────────────────────────────────────────────

  it("throws on non-positive ttlMs", () => {
    expect(() => new InMemoryCache({ ttlMs: 0 })).toThrow("ttlMs");
    expect(() => new InMemoryCache({ ttlMs: -1 })).toThrow("ttlMs");
  });

  it("throws on non-positive maxEntries", () => {
    expect(() => new InMemoryCache({ ttlMs: TTL, maxEntries: 0 })).toThrow("maxEntries");
  });

  // ── get / set ───────────────────────────────────────────────────────────────

  it("returns undefined for missing key", () => {
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns value within TTL", () => {
    cache.set("k", "v");
    now = TTL - 1; // one ms before expiry
    expect(cache.get("k")).toBe("v");
  });

  it("returns undefined exactly at expiry boundary", () => {
    cache.set("k", "v");
    now = TTL; // expiresAt === now → expired
    expect(cache.get("k")).toBeUndefined();
  });

  it("returns undefined after TTL", () => {
    cache.set("k", "v");
    now = TTL + 1;
    expect(cache.get("k")).toBeUndefined();
  });

  it("set accepts per-entry ttlMs override", () => {
    cache.set("k", "v", TTL * 2);
    now = TTL + 1; // past default TTL but within override
    expect(cache.get("k")).toBe("v");
  });

  it("set throws on invalid per-entry ttlMs", () => {
    expect(() => cache.set("k", "v", 0)).toThrow("ttlMs");
  });

  // ── getOrLoad ───────────────────────────────────────────────────────────────

  it("returns source:origin on miss and caches the value", async () => {
    const loader = jest.fn().mockResolvedValue("loaded");
    const result = await cache.getOrLoad("k", loader);
    expect(result).toEqual({ value: "loaded", source: "origin" });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("returns source:cache on hit without calling loader", async () => {
    cache.set("k", "cached");
    const loader = jest.fn();
    const result = await cache.getOrLoad("k", loader);
    expect(result).toEqual({ value: "cached", source: "cache" });
    expect(loader).not.toHaveBeenCalled();
  });

  it("reloads after TTL expiry", async () => {
    const loader = jest.fn().mockResolvedValue("fresh");
    await cache.getOrLoad("k", loader);
    now = TTL + 1;
    const result = await cache.getOrLoad("k", loader);
    expect(result.source).toBe("origin");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("repeated reads within TTL all return source:cache", async () => {
    const loader = jest.fn().mockResolvedValue("v");
    await cache.getOrLoad("k", loader); // miss → loads
    for (let i = 0; i < 5; i++) {
      now = i * 10; // still within TTL
      const r = await cache.getOrLoad("k", loader);
      expect(r.source).toBe("cache");
    }
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("concurrent getOrLoad calls each invoke the loader (no in-flight dedup)", async () => {
    // The cache has no in-flight deduplication: two concurrent misses both
    // call the loader. Each resolves independently with its own value.
    const loader = jest.fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");

    const [r1, r2] = await Promise.all([
      cache.getOrLoad("k", loader),
      cache.getOrLoad("k", loader),
    ]);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(r1.source).toBe("origin");
    expect(r2.source).toBe("origin");
    // Both return their own loaded value
    expect(r1.value).toBe("first");
    expect(r2.value).toBe("second");
  });

  // ── invalidate ──────────────────────────────────────────────────────────────

  it("invalidate removes an existing key and returns true", () => {
    cache.set("k", "v");
    expect(cache.invalidate("k")).toBe(true);
    expect(cache.get("k")).toBeUndefined();
  });

  it("invalidate returns false for a missing key", () => {
    expect(cache.invalidate("nope")).toBe(false);
  });

  it("invalidate during load causes next getOrLoad to reload", async () => {
    const loader = jest.fn().mockResolvedValue("v");
    await cache.getOrLoad("k", loader);
    cache.invalidate("k");
    const result = await cache.getOrLoad("k", loader);
    expect(result.source).toBe("origin");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  // ── invalidateByPrefix ──────────────────────────────────────────────────────

  it("invalidateByPrefix removes all matching keys and returns count", () => {
    cache.set("a:1", "v1");
    cache.set("a:2", "v2");
    cache.set("b:1", "v3");
    expect(cache.invalidateByPrefix("a:")).toBe(2);
    expect(cache.get("a:1")).toBeUndefined();
    expect(cache.get("a:2")).toBeUndefined();
    expect(cache.get("b:1")).toBe("v3");
  });

  it("invalidateByPrefix returns 0 when no keys match", () => {
    cache.set("x", "v");
    expect(cache.invalidateByPrefix("z")).toBe(0);
  });

  // ── clear ───────────────────────────────────────────────────────────────────

  it("clear removes all entries", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  // ── size ────────────────────────────────────────────────────────────────────

  it("size excludes expired entries", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    now = TTL + 1;
    expect(cache.size()).toBe(0);
  });

  // ── LRU eviction ───────────────────────────────────────────────────────────

  it("evicts least-recently-used entry when maxEntries is reached", () => {
    const small = new InMemoryCache<string>({ ttlMs: TTL, maxEntries: 2, clock: () => now });
    small.set("a", "1"); now = 1;
    small.set("b", "2"); now = 2;
    small.get("a");      // touch 'a' → 'b' is now LRU
    now = 3;
    small.set("c", "3"); // should evict 'b'
    expect(small.get("b")).toBeUndefined();
    expect(small.get("a")).toBe("1");
    expect(small.get("c")).toBe("3");
  });
});
