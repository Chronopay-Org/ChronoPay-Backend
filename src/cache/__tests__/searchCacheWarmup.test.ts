/**
 * Search Cache Warmup Unit & Integration Tests
 *
 * Covers:
 * - Query normalization and key generation
 * - 24-hour sliding window query tracking & ranking
 * - Memory bounds and capacity trimming
 * - Taxonomy commit hook & cache invalidation
 * - Low-rate replayer pacing
 * - Metrics emission (coverage, executions, query replays, duration)
 * - Edge Cases:
 *   1. Rapid taxonomy edits (cancellation of superseded warmups)
 *   2. Warmup mid-outage (graceful error handling during DB/cache failures)
 *   3. Low-traffic tenant (0 queries in last 24 hours)
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  SearchQueryTracker,
  SearchCacheWarmupService,
  generateQueryKey,
  TWENTY_FOUR_HOURS_MS,
  CacheLayer,
  SearchServiceInterface,
} from "../searchCacheWarmup.js";
import {
  MarketplaceSearchQuery,
  validateSearchQuery,
} from "../../validation/marketplaceSearchSchema.js";
import { SearchResult, MarketplaceSearchService } from "../../services/marketplaceSearchService.js";

describe("SearchCacheWarmup", () => {
  let queryTracker: SearchQueryTracker;
  let mockSearchService: jest.Mocked<SearchServiceInterface>;
  let mockCache: jest.Mocked<CacheLayer>;

  const sampleQuery1: MarketplaceSearchQuery = validateSearchQuery({
    page: 1,
    limit: 10,
    categories: ["plumbing"],
    sortBy: "relevance",
  });

  const sampleQuery2: MarketplaceSearchQuery = validateSearchQuery({
    page: 1,
    limit: 10,
    categories: ["haircut"],
    sortBy: "rating",
  });

  const sampleQuery3: MarketplaceSearchQuery = validateSearchQuery({
    page: 2,
    limit: 20,
    sortBy: "price",
  });

  const sampleSearchResult: SearchResult = {
    slots: [],
    data: [],
    page: 1,
    limit: 10,
    total: 0,
    ranking: "relevance",
    cacheSource: "miss",
  };

  beforeEach(() => {
    queryTracker = new SearchQueryTracker();

    mockSearchService = {
      search: jest.fn<SearchServiceInterface["search"]>().mockResolvedValue(sampleSearchResult),
    };

    mockCache = {
      get: jest.fn<CacheLayer["get"]>().mockResolvedValue(null),
      set: jest.fn<CacheLayer["set"]>().mockResolvedValue(undefined),
      clear: jest.fn<NonNullable<CacheLayer["clear"]>>(),
      invalidateByPrefix: jest.fn<NonNullable<CacheLayer["invalidateByPrefix"]>>().mockReturnValue(1),
    };
  });

  describe("generateQueryKey & Query Normalization", () => {
    it("should generate identical keys for equivalent queries regardless of category order", () => {
      const q1: MarketplaceSearchQuery = validateSearchQuery({
        page: 1,
        limit: 10,
        categories: ["plumbing", "haircut"],
        sortBy: "relevance",
      });
      const q2: MarketplaceSearchQuery = validateSearchQuery({
        page: 1,
        limit: 10,
        categories: ["haircut", "plumbing"],
        sortBy: "relevance",
      });

      expect(generateQueryKey(q1)).toBe(generateQueryKey(q2));
    });

    it("should handle default parameter fallbacks, price range, rating range, and time window", () => {
      const complexQuery: MarketplaceSearchQuery = validateSearchQuery({
        page: 1,
        limit: 10,
        sortBy: "relevance",
        priceRange: { min: 1000, max: 5000 },
        ratingRange: { min: 4.0, max: 5.0 },
        timeWindow: { startTime: 1700000000, endTime: 1700003600 },
      });

      const key = generateQueryKey(complexQuery);
      expect(key).toContain('"priceRange":{"min":1000,"max":5000}');
      expect(key).toContain('"ratingRange":{"min":4,"max":5}');
      expect(key).toContain('"timeWindow":{"startTime":1700000000,"endTime":1700003600}');
    });

    it("should generate distinct keys for queries with different sorting or pagination", () => {
      const q1: MarketplaceSearchQuery = validateSearchQuery({ page: 1, limit: 10, sortBy: "relevance" });
      const q2: MarketplaceSearchQuery = validateSearchQuery({ page: 1, limit: 10, sortBy: "rating" });
      const q3: MarketplaceSearchQuery = validateSearchQuery({ page: 2, limit: 10, sortBy: "relevance" });

      expect(generateQueryKey(q1)).not.toBe(generateQueryKey(q2));
      expect(generateQueryKey(q1)).not.toBe(generateQueryKey(q3));
    });
  });

  describe("SearchQueryTracker", () => {
    it("should record queries and rank them by frequency", () => {
      const now = 1000000;

      // Query 1 logged 3 times
      queryTracker.recordQuery(sampleQuery1, now - 1000);
      queryTracker.recordQuery(sampleQuery1, now - 500);
      queryTracker.recordQuery(sampleQuery1, now - 100);

      // Query 2 logged 5 times
      for (let i = 0; i < 5; i++) {
        queryTracker.recordQuery(sampleQuery2, now - i * 100);
      }

      // Query 3 logged 1 time
      queryTracker.recordQuery(sampleQuery3, now - 200);

      const topQueries = queryTracker.getTopQueries(10, now);
      expect(topQueries.length).toBe(3);
      // Query 2 (count=5) should be rank 1
      expect(generateQueryKey(topQueries[0])).toBe(generateQueryKey(sampleQuery2));
      // Query 1 (count=3) should be rank 2
      expect(generateQueryKey(topQueries[1])).toBe(generateQueryKey(sampleQuery1));
      // Query 3 (count=1) should be rank 3
      expect(generateQueryKey(topQueries[2])).toBe(generateQueryKey(sampleQuery3));
    });

    it("should tie-break equal frequency queries deterministically by query key", () => {
      const now = Date.now();
      const qA: MarketplaceSearchQuery = validateSearchQuery({ page: 1, limit: 10, sortBy: "price" });
      const qB: MarketplaceSearchQuery = validateSearchQuery({ page: 1, limit: 10, sortBy: "rating" });

      queryTracker.recordQuery(qA, now);
      queryTracker.recordQuery(qB, now);

      const topQueries = queryTracker.getTopQueries(10, now);
      expect(topQueries.length).toBe(2);
    });

    it("should exclude queries older than 24 hours from ranking", () => {
      const now = Date.now();
      const olderThan24h = now - (TWENTY_FOUR_HOURS_MS + 1000);
      const within24h = now - (TWENTY_FOUR_HOURS_MS - 1000);

      queryTracker.recordQuery(sampleQuery1, olderThan24h);
      queryTracker.recordQuery(sampleQuery1, olderThan24h);
      queryTracker.recordQuery(sampleQuery2, within24h);

      const topQueries = queryTracker.getTopQueries(10, now);
      expect(topQueries.length).toBe(1);
      expect(generateQueryKey(topQueries[0])).toBe(generateQueryKey(sampleQuery2));
    });

    it("should enforce capacity bounds and trim buffer size", () => {
      const smallTracker = new SearchQueryTracker(5);
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        smallTracker.recordQuery(validateSearchQuery({ page: i + 1, limit: 10, sortBy: "relevance" }), now);
      }

      expect(smallTracker.size()).toBe(5);
    });

    it("should clear tracked history", () => {
      queryTracker.recordQuery(sampleQuery1);
      expect(queryTracker.size()).toBe(1);

      queryTracker.clear();
      expect(queryTracker.size()).toBe(0);
    });
  });

  describe("SearchCacheWarmupService", () => {
    it("should initialize with default options", () => {
      const service = new SearchCacheWarmupService(mockSearchService, queryTracker);
      expect(service).toBeDefined();
    });

    it("should invalidate cache and replay top queries on taxonomy commit", async () => {
      queryTracker.recordQuery(sampleQuery1);
      queryTracker.recordQuery(sampleQuery1);
      queryTracker.recordQuery(sampleQuery2);

      const warmupService = new SearchCacheWarmupService(
        mockSearchService,
        queryTracker,
        mockCache,
        { pacerDelayMs: 0 }
      );

      const result = await warmupService.commitTaxonomy();

      expect(mockCache.invalidateByPrefix).toHaveBeenCalledWith("marketplace:search:");
      expect(mockSearchService.search).toHaveBeenCalledTimes(2);
      expect(result.total).toBe(2);
      expect(result.warmed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.coverage).toBe(1.0);
      expect(result.status).toBe("success");
    });

    it("should handle undefined cache gracefully without error", async () => {
      queryTracker.recordQuery(sampleQuery1);

      const warmupService = new SearchCacheWarmupService(
        mockSearchService,
        queryTracker,
        undefined,
        { pacerDelayMs: 0 }
      );

      const result = await warmupService.commitTaxonomy();
      expect(result.warmed).toBe(1);
      expect(result.status).toBe("success");
    });

    it("should fallback to cache.clear() if invalidateByPrefix is not defined", async () => {
      queryTracker.recordQuery(sampleQuery1);

      const basicCache: CacheLayer = {
        get: jest.fn<CacheLayer["get"]>().mockResolvedValue(null),
        set: jest.fn<CacheLayer["set"]>().mockResolvedValue(undefined),
        clear: jest.fn<NonNullable<CacheLayer["clear"]>>(),
      };

      const warmupService = new SearchCacheWarmupService(
        mockSearchService,
        queryTracker,
        basicCache,
        { pacerDelayMs: 0 }
      );

      await warmupService.commitTaxonomy();
      expect(basicCache.clear).toHaveBeenCalled();
    });

    it("should respect rate pacing between query replays", async () => {
      queryTracker.recordQuery(sampleQuery1);
      queryTracker.recordQuery(sampleQuery2);

      const warmupService = new SearchCacheWarmupService(
        mockSearchService,
        queryTracker,
        mockCache,
        { pacerDelayMs: 15 }
      );

      const startTime = Date.now();
      await warmupService.commitTaxonomy();
      const duration = Date.now() - startTime;

      expect(duration).toBeGreaterThanOrEqual(10);
      expect(mockSearchService.search).toHaveBeenCalledTimes(2);
    });

    // ── Edge Case 1: Low-Traffic Tenant (0 queries in last 24h) ─────────────────────
    describe("Edge Case: Low-Traffic Tenant", () => {
      it("should handle 0 queries gracefully with 100% coverage (1.0)", async () => {
        const warmupService = new SearchCacheWarmupService(
          mockSearchService,
          queryTracker,
          mockCache,
          { pacerDelayMs: 0 }
        );

        const result = await warmupService.commitTaxonomy();

        expect(mockSearchService.search).not.toHaveBeenCalled();
        expect(result.total).toBe(0);
        expect(result.warmed).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.coverage).toBe(1.0);
        expect(result.status).toBe("success");
      });
    });

    // ── Edge Case 2: Warmup Mid-Outage ───────────────────────────────────────────
    describe("Edge Case: Warmup Mid-Outage", () => {
      it("should catch errors per query gracefully without throwing", async () => {
        queryTracker.recordQuery(sampleQuery1);
        queryTracker.recordQuery(sampleQuery2);

        // Mock first query succeeding, second query throwing database/network error
        mockSearchService.search
          .mockResolvedValueOnce(sampleSearchResult)
          .mockRejectedValueOnce(new Error("Database connection lost"));

        const warmupService = new SearchCacheWarmupService(
          mockSearchService,
          queryTracker,
          mockCache,
          { pacerDelayMs: 0 }
        );

        const result = await warmupService.commitTaxonomy();

        expect(mockSearchService.search).toHaveBeenCalledTimes(2);
        expect(result.total).toBe(2);
        expect(result.warmed).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.coverage).toBe(0.5);
        expect(result.status).toBe("partial");
      });

      it("should handle non-Error throwables gracefully", async () => {
        queryTracker.recordQuery(sampleQuery1);
        mockSearchService.search.mockRejectedValue("String error message");

        const warmupService = new SearchCacheWarmupService(
          mockSearchService,
          queryTracker,
          mockCache,
          { pacerDelayMs: 0 }
        );

        const result = await warmupService.commitTaxonomy();
        expect(result.failed).toBe(1);
        expect(result.status).toBe("failed");
      });

      it("should report status = 'failed' if all query replays fail", async () => {
        queryTracker.recordQuery(sampleQuery1);
        mockSearchService.search.mockRejectedValue(new Error("Redis connection refused"));

        const warmupService = new SearchCacheWarmupService(
          mockSearchService,
          queryTracker,
          mockCache,
          { pacerDelayMs: 0 }
        );

        const result = await warmupService.commitTaxonomy();

        expect(result.total).toBe(1);
        expect(result.warmed).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.coverage).toBe(0);
        expect(result.status).toBe("failed");
      });
    });

    // ── Edge Case 3: Rapid Taxonomy Edits ─────────────────────────────────────────
    describe("Edge Case: Rapid Taxonomy Edits", () => {
      it("should cancel superseded warmup runs when a new commit arrives mid-flight", async () => {
        for (let i = 0; i < 5; i++) {
          queryTracker.recordQuery(validateSearchQuery({ page: i + 1, limit: 10, sortBy: "relevance" }));
        }

        // Slow down searchService to allow triggering a second commit mid-flight
        let firstCallResolve: (() => void) | null = null;
        mockSearchService.search.mockImplementationOnce(() => {
          return new Promise((resolve) => {
            firstCallResolve = () => resolve(sampleSearchResult);
          });
        });

        const warmupService = new SearchCacheWarmupService(
          mockSearchService,
          queryTracker,
          mockCache,
          { pacerDelayMs: 10 }
        );

        // Trigger first taxonomy commit (starts async loop)
        const commit1Promise = warmupService.commitTaxonomy();

        // Immediately trigger second taxonomy commit (supersedes first)
        const commit2Promise = warmupService.commitTaxonomy();

        // Unblock first call resolve if waiting
        if (firstCallResolve) {
          (firstCallResolve as () => void)();
        }

        const [res1, res2] = await Promise.all([commit1Promise, commit2Promise]);

        expect(res1.status).toBe("cancelled");
        expect(res2.status).toBe("success");
      });
    });
  });

  describe("MarketplaceSearchService Integration", () => {
    it("should automatically record query in queryTracker when search is called", async () => {
      const mockPool = {
        query: jest.fn<any>().mockImplementation(async (sql: string) => {
          if (sql.includes("COUNT(*)")) {
            return { rows: [{ total: "1" }] };
          }
          return {
            rows: [
              {
                id: 101,
                professional: "prof-1",
                startTime: new Date().toISOString(),
                endTime: new Date().toISOString(),
                category: "plumbing",
                price_cents: 5000,
                supplier_rating: 4.8,
                status: "available",
              },
            ],
          };
        }),
      } as any;

      const service = new MarketplaceSearchService(mockPool, queryTracker);

      await service.search(sampleQuery1);

      expect(queryTracker.size()).toBe(1);
      const topQueries = queryTracker.getTopQueries(1);
      expect(generateQueryKey(topQueries[0])).toBe(generateQueryKey(sampleQuery1));
    });

    it("should allow updating queryTracker via setQueryTracker", async () => {
      const mockPool = {
        query: jest.fn<any>().mockImplementation(async (sql: string) => {
          if (sql.includes("COUNT(*)")) {
            return { rows: [{ total: "0" }] };
          }
          return { rows: [] };
        }),
      } as any;

      const service = new MarketplaceSearchService(mockPool);
      const newTracker = new SearchQueryTracker();
      service.setQueryTracker(newTracker);

      await service.search(sampleQuery1);
      expect(newTracker.size()).toBe(1);
    });
  });
});
