/**
 * Focused behavior coverage for src/cache/facetCountsCache.ts.
 *
 * Covers:
 * - FacetFilterSignature derivation through buildFacetCacheKey (equivalent vs
 *   non-equivalent filter sets, plus empty / malformed inputs)
 * - The FacetCounts read-miss -> database write -> cache-hit lifecycle
 * - FacetCacheWriteEvent recording and the freshness overlay it drives
 * - Freshness-window, TTL-expiry and LRU-eviction boundaries
 * - Invalidation (single signature and full clear) and database failure paths
 *
 * Time is driven by Jest fake timers, so every TTL / freshness boundary is
 * deterministic and the suite never sleeps.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { Pool } from "pg";
import {
  FacetCountsCache,
  buildFacetCacheKey,
  type FacetCounts,
  type FacetCacheWriteEvent,
  type FacetFilterSignature,
} from "../facetCountsCache.js";
import {
  validateSearchQuery,
  type MarketplaceSearchQuery,
} from "../../validation/marketplaceSearchSchema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FRESHNESS_MS = 60_000;
const CACHE_TTL_MS = 10 * 60_000;

function makeQuery(overrides: Record<string, unknown> = {}): MarketplaceSearchQuery {
  return validateSearchQuery({ page: 1, limit: 10, ...overrides });
}

interface FacetRows {
  categories?: { category: string; cnt: string | number }[];
  prices?: (number | string)[];
  ratings?: (number | string)[];
  total?: string | number;
}

type FacetQuery = (text: string) => Promise<{ rows: unknown[] }>;

/** Fake pg pool that answers the four facet queries deterministically. */
function makePool(rows: FacetRows, options: { failWith?: Error } = {}) {
  const query = jest.fn<FacetQuery>(async (text) => {
    if (options.failWith) {
      throw options.failWith;
    }
    if (text.includes("GROUP BY category")) {
      return { rows: rows.categories ?? [] };
    }
    if (text.includes("price_cents FROM slots")) {
      return { rows: (rows.prices ?? []).map((price_cents) => ({ price_cents })) };
    }
    if (text.includes("supplier_rating FROM slots")) {
      return { rows: (rows.ratings ?? []).map((supplier_rating) => ({ supplier_rating })) };
    }
    if (text.includes("COUNT(*) as total")) {
      return { rows: rows.total === undefined ? [] : [{ total: rows.total }] };
    }
    throw new Error(`unexpected facet SQL: ${text}`);
  });

  return { pool: { query } as unknown as Pool, query };
}

function priceBucket(counts: FacetCounts, min: number) {
  const bucket = counts.priceRanges.find((range) => range.min === min);
  if (!bucket) {
    throw new Error(`no price bucket starting at ${min}`);
  }
  return bucket;
}

function ratingBucket(counts: FacetCounts, min: number) {
  const bucket = counts.ratingRanges.find((range) => range.min === min);
  if (!bucket) {
    throw new Error(`no rating bucket starting at ${min}`);
  }
  return bucket;
}

function decodeSignature(key: string): FacetFilterSignature {
  const prefix = "facet:counts:";
  expect(key.startsWith(prefix)).toBe(true);
  const encoded = key.slice(prefix.length);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as FacetFilterSignature;
}

function readWriteEvents(cache: FacetCountsCache): FacetCacheWriteEvent[] {
  return (cache as unknown as { writeEvents: FacetCacheWriteEvent[] }).writeEvents;
}

const emptySignature: FacetFilterSignature = {
  categories: [],
  hasPriceRange: false,
  hasRatingRange: false,
  hasTimeWindow: false,
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// buildFacetCacheKey / FacetFilterSignature
// ---------------------------------------------------------------------------

describe("buildFacetCacheKey", () => {
  it("derives the empty signature when no filters are supplied", () => {
    expect(decodeSignature(buildFacetCacheKey(makeQuery()))).toEqual(emptySignature);
  });

  it("sorts categories so equivalent filter sets share one key", () => {
    const first = buildFacetCacheKey(makeQuery({ categories: ["yoga", "massage", "pilates"] }));
    const second = buildFacetCacheKey(makeQuery({ categories: ["pilates", "yoga", "massage"] }));

    expect(first).toBe(second);
    expect(decodeSignature(first).categories).toEqual(["massage", "pilates", "yoga"]);
  });

  it("keeps non-equivalent category sets on separate keys", () => {
    const one = buildFacetCacheKey(makeQuery({ categories: ["massage"] }));
    const two = buildFacetCacheKey(makeQuery({ categories: ["massage", "yoga"] }));

    expect(one).not.toBe(two);
    expect(decodeSignature(one).categories).toEqual(["massage"]);
    expect(decodeSignature(two).categories).toEqual(["massage", "yoga"]);
  });

  it("flips exactly one signature flag per optional filter", () => {
    const price = buildFacetCacheKey(makeQuery({ priceRange: { min: 0, max: 5_000 } }));
    const rating = buildFacetCacheKey(makeQuery({ ratingRange: { min: 4 } }));
    const time = buildFacetCacheKey(makeQuery({ timeWindow: { startTime: 0, endTime: 1 } }));

    expect(decodeSignature(price)).toEqual({ ...emptySignature, hasPriceRange: true });
    expect(decodeSignature(rating)).toEqual({ ...emptySignature, hasRatingRange: true });
    expect(decodeSignature(time)).toEqual({ ...emptySignature, hasTimeWindow: true });

    expect(new Set([buildFacetCacheKey(makeQuery()), price, rating, time]).size).toBe(4);
  });

  it("ignores pagination and presentation fields", () => {
    const first = buildFacetCacheKey(makeQuery({ categories: ["massage"], page: 1, limit: 10 }));
    const second = buildFacetCacheKey(
      makeQuery({
        categories: ["massage"],
        page: 9,
        limit: 100,
        cursor: "opaque-cursor",
        sortBy: "price",
        diversify: false,
        includeFacets: true,
      }),
    );

    expect(first).toBe(second);
  });

  it("treats empty and malformed filter inputs as the empty signature without throwing", () => {
    const malformed = [
      {},
      { categories: [] },
      { categories: null },
      { categories: undefined },
      { priceRange: null, ratingRange: null, timeWindow: null },
    ] as unknown as MarketplaceSearchQuery[];

    for (const query of malformed) {
      expect(() => buildFacetCacheKey(query)).not.toThrow();
      expect(decodeSignature(buildFacetCacheKey(query))).toEqual(emptySignature);
    }
  });
});

// ---------------------------------------------------------------------------
// FacetCounts lifecycle
// ---------------------------------------------------------------------------

describe("FacetCountsCache read -> write -> hit lifecycle", () => {
  it("computes on a miss, serves on a hit, and reloads at the freshness edge", async () => {
    const cache = new FacetCountsCache();
    const { pool, query } = makePool({
      categories: [
        { category: "massage", cnt: "2" },
        { category: "yoga", cnt: "1" },
      ],
      prices: [2_500, 30_000],
      ratings: [4.7, 3.2],
      total: "3",
    });
    const search = makeQuery({ categories: ["massage"] });

    const miss = await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(4);
    expect(miss.fresh).toBe(true);
    expect(miss.categories).toEqual({ massage: 2, yoga: 1 });
    expect(miss.totalMatching).toBe(3);
    expect(priceBucket(miss, 0).count).toBe(1);
    expect(priceBucket(miss, 0).label).toBe("Under $50");
    expect(priceBucket(miss, 15_000).count).toBe(1);
    expect(ratingBucket(miss, 4.5).count).toBe(1);
    expect(ratingBucket(miss, 3.0).count).toBe(1);
    expect(miss.lastRefreshedAt).toBe(0);

    const hit = await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(4);
    expect(hit.categories).toEqual({ massage: 2, yoga: 1 });
    expect(hit.totalMatching).toBe(3);
    expect(hit.lastRefreshedAt).toBe(0);
    expect(hit.fresh).toBe(true);

    jest.setSystemTime(FRESHNESS_MS - 1);
    const stillFresh = await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(4);
    expect(stillFresh.lastRefreshedAt).toBe(0);

    jest.setSystemTime(FRESHNESS_MS);
    const refreshed = await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(8);
    expect(refreshed.lastRefreshedAt).toBe(FRESHNESS_MS);
    expect(refreshed.categories).toEqual({ massage: 2, yoga: 1 });
  });

  it("buckets price and rating rows on inclusive range minima", async () => {
    const cache = new FacetCountsCache();
    const { pool } = makePool({ prices: [4_999, 5_000], ratings: [4.499, 4.5], total: "0" });

    const counts = await cache.getFacetCounts(makeQuery(), pool);

    expect(priceBucket(counts, 0).count).toBe(1);
    expect(priceBucket(counts, 5_000).count).toBe(1);
    expect(priceBucket(counts, 5_000).label).toBe("$50 \u2013 $150");
    expect(ratingBucket(counts, 4.0).count).toBe(1);
    expect(ratingBucket(counts, 4.5).count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FacetCacheWriteEvent
// ---------------------------------------------------------------------------

describe("FacetCacheWriteEvent", () => {
  it("records create / update / delete events with an injected timestamp", () => {
    const cache = new FacetCountsCache();

    jest.setSystemTime(1_000);
    cache.recordSlotCreated({ slotId: 7, category: "massage", priceCents: 2_500, rating: 4.8 });

    jest.setSystemTime(2_000);
    cache.recordSlotUpdated({
      slotId: 7,
      oldCategory: "massage",
      newCategory: "yoga",
      oldPriceCents: 2_500,
      newPriceCents: 30_000,
      oldRating: 4.8,
      newRating: 3.2,
    });

    jest.setSystemTime(3_000);
    cache.recordSlotDeleted({ slotId: 7, category: "yoga", priceCents: 30_000, rating: 3.2 });

    expect(cache.getWriteEventCount()).toBe(3);
    expect(readWriteEvents(cache)).toEqual([
      {
        slotId: 7,
        eventType: "create",
        newCategory: "massage",
        newPriceCents: 2_500,
        newRating: 4.8,
        timestamp: 1_000,
      },
      {
        slotId: 7,
        eventType: "update",
        oldCategory: "massage",
        newCategory: "yoga",
        oldPriceCents: 2_500,
        newPriceCents: 30_000,
        oldRating: 4.8,
        newRating: 3.2,
        timestamp: 2_000,
      },
      {
        slotId: 7,
        eventType: "delete",
        oldCategory: "yoga",
        oldPriceCents: 30_000,
        oldRating: 3.2,
        timestamp: 3_000,
      },
    ]);
  });

  it("bounds the write-event buffer and keeps the newest events in order", () => {
    const cache = new FacetCountsCache();
    (cache as unknown as { maxWriteEvents: number }).maxWriteEvents = 3;

    for (let i = 1; i <= 5; i++) {
      jest.setSystemTime(i * 1_000);
      cache.recordSlotCreated({ slotId: i });
    }

    expect(cache.getWriteEventCount()).toBe(3);
    expect(readWriteEvents(cache).map((event) => event.slotId)).toEqual([3, 4, 5]);
    expect(readWriteEvents(cache).map((event) => event.timestamp)).toEqual([3_000, 4_000, 5_000]);
  });

  it("replays only the events recorded at or after the cached snapshot", async () => {
    const cache = new FacetCountsCache();
    const { pool, query } = makePool({
      categories: [{ category: "massage", cnt: "1" }],
      total: "1",
    });
    const search = makeQuery({ categories: ["massage"] });

    // Recorded before the snapshot, so it is already reflected in the DB counts.
    cache.recordSlotCreated({ slotId: 1, category: "stale" });

    jest.setSystemTime(10_000);
    const snapshot = await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(4);
    expect(snapshot.categories).toEqual({ massage: 1 });
    expect(snapshot.lastRefreshedAt).toBe(10_000);

    jest.setSystemTime(90_000);
    cache.recordSlotCreated({ slotId: 2, category: "fresh" });

    jest.setSystemTime(100_000);
    const overlaid = await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(4);
    expect(overlaid.categories).toEqual({ massage: 1, fresh: 1 });
    expect(overlaid.totalMatching).toBe(2);
    expect(overlaid.lastRefreshedAt).toBe(90_000);
    expect(overlaid.fresh).toBe(true);
  });

  it("overlays create / update / delete events across every bucket", async () => {
    const cache = new FacetCountsCache();
    const { pool, query } = makePool({
      categories: [{ category: "massage", cnt: "2" }],
      prices: [2_500],
      ratings: [4.8],
      total: "2",
    });
    const search = makeQuery({ categories: ["massage"] });

    const initial = await cache.getFacetCounts(search, pool);
    expect(initial.categories).toEqual({ massage: 2 });
    expect(initial.totalMatching).toBe(2);
    expect(priceBucket(initial, 0).count).toBe(1);
    expect(ratingBucket(initial, 4.5).count).toBe(1);

    jest.setSystemTime(70_000);
    cache.recordSlotCreated({ slotId: 10, category: "massage", priceCents: 2_500, rating: 4.8 });
    cache.recordSlotUpdated({
      slotId: 11,
      oldCategory: "yoga",
      newCategory: "pilates",
    });
    cache.recordSlotDeleted({ slotId: 12, category: "massage", priceCents: 2_500, rating: 4.8 });

    jest.setSystemTime(100_000);
    const overlaid = await cache.getFacetCounts(search, pool);

    expect(query).toHaveBeenCalledTimes(4);
    expect(overlaid.categories).toEqual({ massage: 2, pilates: 1 });
    expect(overlaid.totalMatching).toBe(3);
    expect(priceBucket(overlaid, 0).count).toBe(1);
    expect(ratingBucket(overlaid, 4.5).count).toBe(1);
    expect(overlaid.lastRefreshedAt).toBe(70_000);

    // Re-reading rebuilds the overlay from the untouched cached snapshot.
    const again = await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(4);
    expect(again.categories).toEqual({ massage: 2, pilates: 1 });
    expect(priceBucket(again, 0).count).toBe(1);
  });

  it("clamps delete overlays at zero", async () => {
    const cache = new FacetCountsCache();
    const { pool, query } = makePool({
      categories: [{ category: "massage", cnt: "1" }],
      prices: [2_500],
      ratings: [4.8],
      total: "1",
    });
    const search = makeQuery({ categories: ["massage"] });

    await cache.getFacetCounts(search, pool);

    jest.setSystemTime(70_000);
    for (const slotId of [1, 2, 3]) {
      cache.recordSlotDeleted({ slotId, category: "massage", priceCents: 2_500, rating: 4.8 });
    }

    jest.setSystemTime(100_000);
    const counts = await cache.getFacetCounts(search, pool);

    expect(query).toHaveBeenCalledTimes(4);
    expect(counts.categories).toEqual({ massage: 0 });
    expect(counts.totalMatching).toBe(0);
    expect(priceBucket(counts, 0).count).toBe(0);
    expect(ratingBucket(counts, 4.5).count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Invalidation, eviction and expiry
// ---------------------------------------------------------------------------

describe("FacetCountsCache invalidation and eviction", () => {
  const rows: FacetRows = { categories: [{ category: "massage", cnt: "1" }], total: "1" };

  it("invalidateForQuery drops one signature and reports whether it existed", async () => {
    const cache = new FacetCountsCache();
    const { pool, query } = makePool(rows);
    const search = makeQuery({ categories: ["massage"] });

    await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(4);

    expect(cache.invalidateForQuery(search)).toBe(true);
    await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(8);

    expect(cache.invalidateForQuery(makeQuery({ categories: ["yoga"] }))).toBe(false);

    // Equivalent signatures (same categories, different order) invalidate together.
    const ordered = makeQuery({ categories: ["yoga", "massage"] });
    const reordered = makeQuery({ categories: ["massage", "yoga"] });
    await cache.getFacetCounts(ordered, pool);
    expect(query).toHaveBeenCalledTimes(12);
    expect(cache.invalidateForQuery(reordered)).toBe(true);
    await cache.getFacetCounts(reordered, pool);
    expect(query).toHaveBeenCalledTimes(16);
  });

  it("invalidateAll clears both the snapshot cache and the write-event buffer", async () => {
    const cache = new FacetCountsCache();
    const { pool, query } = makePool(rows);
    const search = makeQuery({ categories: ["massage"] });

    await cache.getFacetCounts(search, pool);
    cache.recordSlotCreated({ slotId: 1, category: "massage" });
    expect(cache.getWriteEventCount()).toBe(1);

    cache.invalidateAll();

    expect(cache.getWriteEventCount()).toBe(0);
    await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(8);
  });

  it("evicts the least-recently-used signature once maxEntries is exceeded", async () => {
    const cache = new FacetCountsCache(undefined, { maxEntries: 2 });
    const { pool, query } = makePool(rows);
    const first = makeQuery({ categories: ["a"] });
    const second = makeQuery({ categories: ["b"] });
    const third = makeQuery({ categories: ["c"] });

    await cache.getFacetCounts(first, pool);
    await cache.getFacetCounts(second, pool);
    expect(query).toHaveBeenCalledTimes(8);

    jest.setSystemTime(1_000);
    await cache.getFacetCounts(first, pool); // touches `first`, so `second` is now LRU
    expect(query).toHaveBeenCalledTimes(8);

    jest.setSystemTime(2_000);
    await cache.getFacetCounts(third, pool); // evicts `second`
    expect(query).toHaveBeenCalledTimes(12);

    jest.setSystemTime(3_000);
    await cache.getFacetCounts(first, pool);
    expect(query).toHaveBeenCalledTimes(12);

    await cache.getFacetCounts(second, pool); // cold again
    expect(query).toHaveBeenCalledTimes(16);
  });

  it("expires the snapshot at the TTL boundary even with recent write events", async () => {
    const cache = new FacetCountsCache();
    const { pool, query } = makePool({
      categories: [{ category: "massage", cnt: "1" }],
      prices: [2_500],
      ratings: [4.8],
      total: "1",
    });
    const search = makeQuery({ categories: ["massage"] });

    await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(4);

    jest.setSystemTime(CACHE_TTL_MS - 10_000);
    cache.recordSlotCreated({ slotId: 5, category: "massage", priceCents: 2_500, rating: 4.8 });

    jest.setSystemTime(CACHE_TTL_MS - 1);
    const nearExpiry = await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(4);
    expect(nearExpiry.categories).toEqual({ massage: 2 });
    expect(nearExpiry.lastRefreshedAt).toBe(CACHE_TTL_MS - 10_000);

    jest.setSystemTime(CACHE_TTL_MS);
    const expired = await cache.getFacetCounts(search, pool);
    expect(query).toHaveBeenCalledTimes(8);
    expect(expired.categories).toEqual({ massage: 1 });
    expect(expired.lastRefreshedAt).toBe(CACHE_TTL_MS);
  });
});

// ---------------------------------------------------------------------------
// Fallbacks and failure paths
// ---------------------------------------------------------------------------

describe("FacetCountsCache fallbacks and failure paths", () => {
  it("returns zeroed default buckets when no pool is available", async () => {
    const cache = new FacetCountsCache();
    jest.setSystemTime(5_000);

    const counts = await cache.getFacetCounts(makeQuery());

    expect(counts.categories).toEqual({});
    expect(counts.totalMatching).toBe(0);
    expect(counts.fresh).toBe(true);
    expect(counts.lastRefreshedAt).toBe(5_000);
    expect(counts.priceRanges.every((range) => range.count === 0)).toBe(true);
    expect(counts.ratingRanges.every((range) => range.count === 0)).toBe(true);
    expect(counts.priceRanges.map(({ min, max, label }) => ({ min, max, label }))).toEqual(
      FacetCountsCache.getDefaultPriceRanges(),
    );
    expect(counts.ratingRanges.map(({ min, max, label }) => ({ min, max, label }))).toEqual(
      FacetCountsCache.getDefaultRatingRanges(),
    );
  });

  it("uses the pool injected through setPool()", async () => {
    const cache = new FacetCountsCache();
    const { pool, query } = makePool({
      categories: [{ category: "massage", cnt: "1" }],
      total: "1",
    });
    cache.setPool(pool);

    const counts = await cache.getFacetCounts(makeQuery({ categories: ["massage"] }));

    expect(query).toHaveBeenCalledTimes(4);
    expect(counts.categories).toEqual({ massage: 1 });
  });

  it("treats an empty result set as zeroed facets", async () => {
    const cache = new FacetCountsCache();
    const { pool } = makePool({});

    const counts = await cache.getFacetCounts(makeQuery(), pool);

    expect(counts.categories).toEqual({});
    expect(counts.totalMatching).toBe(0);
    expect(counts.priceRanges.every((range) => range.count === 0)).toBe(true);
    expect(counts.ratingRanges.every((range) => range.count === 0)).toBe(true);
  });

  it("drops rows that fall outside every bucket", async () => {
    const cache = new FacetCountsCache();
    const { pool } = makePool({ prices: [-1, 100_000], ratings: [5.0, 2.99], total: "2" });

    const counts = await cache.getFacetCounts(makeQuery(), pool);

    expect(priceBucket(counts, 100_000).count).toBe(1);
    expect(counts.priceRanges.reduce((sum, range) => sum + range.count, 0)).toBe(1);
    expect(ratingBucket(counts, 0.0).count).toBe(1);
    expect(counts.ratingRanges.reduce((sum, range) => sum + range.count, 0)).toBe(1);
  });

  it("propagates database errors without caching a partial result", async () => {
    const cache = new FacetCountsCache();
    const failing = makePool({}, { failWith: new Error("db down") });
    const search = makeQuery({ categories: ["massage"] });

    await expect(cache.getFacetCounts(search, failing.pool)).rejects.toThrow("db down");
    expect(failing.query).toHaveBeenCalledTimes(4);

    const healthy = makePool({ categories: [{ category: "massage", cnt: "4" }], total: "4" });
    const counts = await cache.getFacetCounts(search, healthy.pool);
    expect(healthy.query).toHaveBeenCalledTimes(4);
    expect(counts.categories).toEqual({ massage: 4 });
  });
});

// ---------------------------------------------------------------------------
// Public static contract
// ---------------------------------------------------------------------------

describe("FacetCountsCache static contract", () => {
  it("exposes the documented freshness window", () => {
    expect(FacetCountsCache.FRESHNESS_WINDOW_MS).toBe(FRESHNESS_MS);
  });

  it("returns defensive copies of the default price and rating buckets", () => {
    const priceRanges = FacetCountsCache.getDefaultPriceRanges();
    expect(priceRanges.map((range) => range.min)).toEqual([0, 5_000, 15_000, 50_000, 100_000]);
    expect(priceRanges[0]).toEqual({ min: 0, max: 5_000, label: "Under $50" });
    expect(priceRanges[4]).toEqual({ min: 100_000, max: Infinity, label: "Over $1000" });

    const ratingRanges = FacetCountsCache.getDefaultRatingRanges();
    expect(ratingRanges.map((range) => range.min)).toEqual([4.5, 4.0, 3.5, 3.0, 0.0]);
    expect(ratingRanges[0]).toEqual({ min: 4.5, max: 5.0, label: "4.5+ stars" });

    priceRanges[0].label = "mutated";
    expect(FacetCountsCache.getDefaultPriceRanges()[0].label).toBe("Under $50");
    expect(FacetCountsCache.getDefaultPriceRanges()).not.toBe(priceRanges);
  });
});
