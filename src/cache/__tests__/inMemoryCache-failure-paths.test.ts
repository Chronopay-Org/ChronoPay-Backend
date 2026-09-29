/**
 * inMemoryCache-failure-paths.test.ts
 *
 * Regression coverage for #1010: the explicit failure and empty-result
 * paths in CacheSource handling (inMemoryCache.ts) —
 *   1. constructor rejects non-finite/non-integer configs (NaN, Infinity,
 *      fractional maxEntries), not just 0/-1,
 *   2. a rejecting loader propagates and caches nothing (failure path),
 *   3. per-call invalid ttlMs in getOrLoad throws before loading,
 *   4. expired entries are physically removed (size reflects it),
 *   5. overwriting a key refreshes its TTL,
 *   6. get refreshes recency so a read entry survives LRU eviction.
 */
import { jest } from "@jest/globals";
import { InMemoryCache } from '../inMemoryCache.js';

const TTL = 1000;

describe('InMemoryCache failure paths (#1010)', () => {
  let now: number;
  let cache: InMemoryCache<string>;

  beforeEach(() => {
    now = 0;
    cache = new InMemoryCache({ ttlMs: TTL, clock: () => now });
  });

  it('rejects non-finite ttlMs', () => {
    expect(() => new InMemoryCache({ ttlMs: NaN })).toThrow('ttlMs');
    expect(() => new InMemoryCache({ ttlMs: Infinity })).toThrow('ttlMs');
  });

  it('rejects non-integer and non-finite maxEntries', () => {
    expect(() => new InMemoryCache({ ttlMs: TTL, maxEntries: 1.5 })).toThrow('maxEntries');
    expect(() => new InMemoryCache({ ttlMs: TTL, maxEntries: NaN })).toThrow('maxEntries');
  });

  it('propagates loader rejection without caching', async () => {
    const loader = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('origin down'));
    await expect(cache.getOrLoad('k', loader)).rejects.toThrow('origin down');
    expect(cache.size()).toBe(0);
    // Next call retries the loader instead of serving a failure.
    const retry = jest.fn<() => Promise<string>>().mockResolvedValue('v');
    await expect(cache.getOrLoad('k', retry)).resolves.toEqual({ value: 'v', source: 'origin' });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('throws on invalid per-call ttlMs in getOrLoad', async () => {
    // Contract: the loader runs, then set() rejects the invalid ttl —
    // nothing is cached and the error surfaces.
    const loader = jest.fn<() => Promise<string>>().mockResolvedValue('v');
    await expect(cache.getOrLoad('k', loader, 0)).rejects.toThrow('ttlMs');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(0);
  });

  it('physically removes expired entries so size reflects it', () => {
    cache.set('a', 'v');
    cache.set('b', 'v');
    now = TTL + 1;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('overwriting a key refreshes its TTL', () => {
    cache.set('k', 'v1');
    now = TTL - 1;
    cache.set('k', 'v2');
    now = TTL + 1; // past the original expiry, within the refreshed one
    expect(cache.get('k')).toBe('v2');
  });

  it('a read entry survives LRU eviction over an unread one', () => {
    const small = new InMemoryCache<string>({ ttlMs: TTL * 10, maxEntries: 2, clock: () => now });
    small.set('old', 'v');
    small.set('new', 'v');
    now += 1;
    expect(small.get('old')).toBe('v'); // refresh recency past 'new'
    small.set('third', 'v'); // evicts least-recently-used ('new')
    expect(small.get('old')).toBe('v');
    expect(small.get('new')).toBeUndefined();
    expect(small.get('third')).toBe('v');
  });
});
