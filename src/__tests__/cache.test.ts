import { jest } from "@jest/globals";
import { InMemoryCache } from "../cache/inMemoryCache.js";

describe("InMemoryCache", () => {
  let currentTime: number;

  const clock = () => currentTime;

  beforeEach(() => {
    currentTime = 1_000;
  });

  it("rejects invalid constructor options", () => {
    expect(() => new InMemoryCache<string>({ ttlMs: 0, clock })).toThrow(
      "Cache ttlMs must be a positive number",
    );

    expect(() => new InMemoryCache<string>({ ttlMs: 100, maxEntries: 0, clock })).toThrow(
      "Cache maxEntries must be a positive integer",
    );
  });

  it("returns cached values until the ttl expires", () => {
    const cache = new InMemoryCache<string>({ ttlMs: 50, clock });

    cache.set("slots:list:all", "cached");

    expect(cache.get("slots:list:all")).toBe("cached");

    currentTime += 51;

    expect(cache.get("slots:list:all")).toBeUndefined();
  });

  it("loads values once and serves repeated reads from cache", async () => {
    const cache = new InMemoryCache<number>({ ttlMs: 100, clock });
    const loader = jest.fn(async () => 42);

    await expect(cache.getOrLoad("answer", loader)).resolves.toEqual({
      value: 42,
      source: "origin",
    });

    await expect(cache.getOrLoad("answer", loader)).resolves.toEqual({
      value: 42,
      source: "cache",
    });

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("invalidates entries by prefix without touching other keys", () => {
    const cache = new InMemoryCache<string[]>({ ttlMs: 100, clock });

    cache.set("slots:list:all", ["a"]);
    cache.set("slots:detail:1", ["b"]);

    expect(cache.invalidateByPrefix("slots:list")).toBe(1);
    expect(cache.get("slots:list:all")).toBeUndefined();
    expect(cache.get("slots:detail:1")).toEqual(["b"]);
  });

  it("invalidates individual keys and clears expired entries from size checks", () => {
    const cache = new InMemoryCache<string>({ ttlMs: 10, clock });

    cache.set("a", "value");
    cache.set("b", "value", 5);

    expect(cache.invalidate("a")).toBe(true);
    expect(cache.invalidate("missing")).toBe(false);

    currentTime += 6;

    expect(cache.size()).toBe(0);
  });

  it("evicts the least recently used entry when max size is reached", () => {
    const cache = new InMemoryCache<string>({ ttlMs: 100, maxEntries: 2, clock });

    cache.set("a", "first");
    currentTime += 1;
    cache.set("b", "second");
    currentTime += 1;
    expect(cache.get("a")).toBe("first");
    currentTime += 1;
    cache.set("c", "third");

    expect(cache.get("a")).toBe("first");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("third");
  });

  it("rejects invalid per-entry ttl values and supports clearing the cache", () => {
    const cache = new InMemoryCache<string>({ ttlMs: 100, clock });

    expect(() => cache.set("a", "value", 0)).toThrow(
      "Cache entry ttlMs must be a positive number",
    );

    cache.set("a", "value");
    cache.clear();

    expect(cache.size()).toBe(0);
  });
});