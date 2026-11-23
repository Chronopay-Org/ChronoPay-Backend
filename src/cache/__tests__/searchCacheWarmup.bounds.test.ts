/**
 * Search Cache Warmup — constants, capacity bounds, and invalid-input coverage.
 *
 * Focused companion to `searchCacheWarmup.test.ts`. This suite closes the gaps
 * called out for `src/cache/searchCacheWarmup.ts`:
 *   - `MAX_TRACKED_QUERIES` and `TWENTY_FOUR_HOURS_MS` are asserted directly.
 *   - The default tracker is proven to bound memory at `MAX_TRACKED_QUERIES`.
 *   - Invalid / boundary inputs (topN = 0, maxEntries = 0, malformed query
 *     objects, exact 24h cutoff) are exercised deterministically.
 *   - The primary state transitions (empty history, all-fail, unsupported
 *     cache shapes) are covered.
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  SearchQueryTracker,
  SearchCacheWarmupService,
  generateQueryKey,
  TWENTY_FOUR_HOURS_MS,
  MAX_TRACKED_QUERIES,
  CacheLayer,
  SearchServiceInterface,
} from "../searchCacheWarmup.js";
import type { MarketplaceSearchQuery } from "../../validation/marketplaceSearchSchema.js";
import type { SearchResult } from "../../services/marketplaceSearchService.js";

const sampleResult: SearchResult = {
  slots: [],
  data: [],
  page: 1,
  limit: 10,
  total: 0,
  ranking: "relevance",
  cacheSource: "miss",
};

function query(sortBy: MarketplaceSearchQuery["sortBy"]): MarketplaceSearchQuery {
  return { page: 1, limit: 10, sortBy } as unknown as MarketplaceSearchQuery;
}

describe("searchCacheWarmup constants", () => {
  it("exposes TWENTY_FOUR_HOURS_MS as a positive 24h window", () => {
    expect(TWENTY_FOUR_HOURS_MS).toBe(24 * 60 * 60 * 1000);
    expect(Number.isInteger(TWENTY_FOUR_HOURS_MS)).toBe(true);
    expect(TWENTY_FOUR_HOURS_MS).toBeGreaterThan(0);
  });

  it("bounds tracked memory at MAX_TRACKED_QUERIES = 1000", () => {
    expect(MAX_TRACKED_QUERIES).toBe(1000);
    expect(Number.isInteger(MAX_TRACKED_QUERIES)).toBe(true);
  });

  it("defaults the tracker capacity to MAX_TRACKED_QUERIES", () => {
    const tracker = new SearchQueryTracker();
    const now = 1_000_000_000;
    // Record one past the documented bound.
    for (let i = 0; i < MAX_TRACKED_QUERIES + 5; i++) {
      tracker.recordQuery(
        { page: i + 1, limit: 10, sortBy: "relevance" } as unknown as MarketplaceSearchQuery,
        now + i,
      );
    }
    expect(tracker.size()).toBe(MAX_TRACKED_QUERIES);
  });
});

describe("SearchQueryTracker capacity & invalid inputs", () => {
  it("handles maxEntries = 0 by retaining nothing", () => {
    const tracker = new SearchQueryTracker(0);
    tracker.recordQuery(query("relevance"), 1_000);
    expect(tracker.size()).toBe(0);
    expect(tracker.getTopQueries(10, 1_001)).toEqual([]);
  });

  it("keeps only the newest record when maxEntries = 1", () => {
    const tracker = new SearchQueryTracker(1);
    const now = 5_000;
    tracker.recordQuery(query("price"), now);
    tracker.recordQuery(query("rating"), now + 1);

    expect(tracker.size()).toBe(1);
    const top = tracker.getTopQueries(10, now + 1);
    expect(top.length).toBe(1);
    expect(generateQueryKey(top[0])).toBe(generateQueryKey(query("rating")));
  });

  it("prunes records that fall outside the 24h window on the next record", () => {
    const tracker = new SearchQueryTracker();
    const t0 = 1_000;
    tracker.recordQuery(query("relevance"), t0);
    expect(tracker.size()).toBe(1);

    const t1 = t0 + TWENTY_FOUR_HOURS_MS + 1;
    tracker.recordQuery(query("price"), t1);
    expect(tracker.size()).toBe(1);
  });

  it("treats the exact 24h cutoff as inclusive and one ms older as expired", () => {
    const tracker = new SearchQueryTracker();
    const now = 2_000_000;
    tracker.recordQuery(query("relevance"), now - TWENTY_FOUR_HOURS_MS);
    tracker.recordQuery(query("price"), now - TWENTY_FOUR_HOURS_MS - 1);

    const top = tracker.getTopQueries(10, now);
    expect(top.length).toBe(1);
    expect(generateQueryKey(top[0])).toBe(generateQueryKey(query("relevance")));
  });

  it("returns an empty ranking for topN = 0", () => {
    const tracker = new SearchQueryTracker();
    tracker.recordQuery(query("relevance"), 100);
    expect(tracker.getTopQueries(0, 101)).toEqual([]);
  });

  it("returns every distinct query when topN exceeds the distinct count", () => {
    const tracker = new SearchQueryTracker();
    tracker.recordQuery(query("relevance"), 100);
    tracker.recordQuery(query("price"), 101);
    expect(tracker.getTopQueries(99, 102).length).toBe(2);
  });

  it("normalises malformed query objects without throwing", () => {
    const empty = {} as MarketplaceSearchQuery;
    const undefinedFields = {
      page: undefined,
      limit: undefined,
      sortBy: undefined,
      categories: undefined,
      priceRange: undefined,
    } as unknown as MarketplaceSearchQuery;

    expect(() => generateQueryKey(empty)).not.toThrow();
    // Both objects fall back to the same defaults, so they normalise equally.
    expect(generateQueryKey(empty)).toBe(generateQueryKey(undefinedFields));
  });
});

describe("SearchCacheWarmupService boundary transitions", () => {
  function deps() {
    const searchService = {
      search: jest.fn<SearchServiceInterface["search"]>().mockResolvedValue(sampleResult),
    } as jest.Mocked<SearchServiceInterface>;
    return searchService;
  }

  it("short-circuits to 100% coverage when topN is 0", async () => {
    const searchService = deps();
    const tracker = new SearchQueryTracker();
    tracker.recordQuery(query("relevance"));

    const service = new SearchCacheWarmupService(searchService, tracker, undefined, {
      topN: 0,
      pacerDelayMs: 0,
    });

    const result = await service.commitTaxonomy();
    expect(searchService.search).not.toHaveBeenCalled();
    expect(result).toMatchObject({ total: 0, warmed: 0, failed: 0, coverage: 1.0, status: "success" });
  });

  it("reports 'failed' when every replay throws a non-Error value", async () => {
    const searchService = deps();
    searchService.search.mockRejectedValue("boom" as never);
    const tracker = new SearchQueryTracker();
    tracker.recordQuery(query("relevance"));

    const service = new SearchCacheWarmupService(searchService, tracker, undefined, { pacerDelayMs: 0 });
    const result = await service.commitTaxonomy();

    expect(result).toMatchObject({ total: 1, warmed: 0, failed: 1, coverage: 0, status: "failed" });
  });

  it("tolerates a cache implementation with neither invalidateByPrefix nor clear", async () => {
    const searchService = deps();
    const minimalCache = {
      get: jest.fn<CacheLayer["get"]>().mockResolvedValue(null),
      set: jest.fn<CacheLayer["set"]>().mockResolvedValue(undefined),
    } as unknown as CacheLayer;
    const tracker = new SearchQueryTracker();
    tracker.recordQuery(query("relevance"));

    const service = new SearchCacheWarmupService(searchService, tracker, minimalCache, { pacerDelayMs: 0 });
    const result = await service.commitTaxonomy();

    expect(result.status).toBe("success");
    expect(result.warmed).toBe(1);
  });

  it("counts a Promise-returning invalidateByPrefix without awaiting it", async () => {
    const searchService = deps();
    const cache = {
      get: jest.fn<CacheLayer["get"]>().mockResolvedValue(null),
      set: jest.fn<CacheLayer["set"]>().mockResolvedValue(undefined),
      invalidateByPrefix: jest.fn<NonNullable<CacheLayer["invalidateByPrefix"]>>().mockResolvedValue(3),
    } as unknown as jest.Mocked<CacheLayer>;
    const tracker = new SearchQueryTracker();
    tracker.recordQuery(query("relevance"));

    const service = new SearchCacheWarmupService(searchService, tracker, cache, { pacerDelayMs: 0 });
    const result = await service.commitTaxonomy();

    expect(cache.invalidateByPrefix).toHaveBeenCalledWith("marketplace:search:");
    expect(result.status).toBe("success");
  });
});
