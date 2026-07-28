/**
 * Search Cache Warmup Service & Query Tracker
 *
 * Pre-populates top search queries after tag taxonomy commits to eliminate cold-cache latency.
 * 
 * Key Features & Edge Cases:
 * 1. 24-Hour Top-N Query Ranking: Ranks queries by search frequency over a sliding 24-hour window.
 * 2. Low-Rate Pacing: Replays top queries sequentially with rate pacing to prevent load spikes.
 * 3. Rapid Taxonomy Edits: Superseded warmups are cancelled via sequence tracking.
 * 4. Warmup Mid-Outage: Catches and logs query execution errors without throwing or stopping the replay loop.
 * 5. Low-Traffic Tenant: Gracefully handles empty query history, reporting 100% coverage (1.0).
 * 6. Security: Normalizes search inputs and bounds memory to 1000 queries max.
 */

import { MarketplaceSearchQuery } from "../validation/marketplaceSearchSchema.js";
import { SearchResult } from "../services/marketplaceSearchService.js";
import {
  recordWarmupCoverage,
  recordWarmupExecution,
  recordWarmupQueryReplayed,
  recordWarmupDuration,
} from "../metrics.js";

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
export const MAX_TRACKED_QUERIES = 1000;

export interface CacheLayer {
  get: (key: string) => Promise<SearchResult | null>;
  set: (key: string, value: SearchResult, ttlMs: number) => Promise<void>;
  clear?: () => void;
  invalidateByPrefix?: (prefix: string) => number | Promise<number>;
}

export interface SearchServiceInterface {
  search: (query: MarketplaceSearchQuery, cache?: CacheLayer) => Promise<SearchResult>;
}

export interface QueryRecord {
  query: MarketplaceSearchQuery;
  key: string;
  timestamp: number;
}

/**
 * Generate a deterministic key for query normalization & deduplication.
 */
export function generateQueryKey(query: MarketplaceSearchQuery): string {
  const normalized = {
    page: query.page ?? 1,
    limit: query.limit ?? 10,
    sortBy: query.sortBy ?? "relevance",
    categories: query.categories ? [...query.categories].sort() : [],
    priceRange: query.priceRange ? { min: query.priceRange.min, max: query.priceRange.max } : null,
    ratingRange: query.ratingRange ? { min: query.ratingRange.min, max: query.ratingRange.max } : null,
    timeWindow: query.timeWindow ? { startTime: query.timeWindow.startTime, endTime: query.timeWindow.endTime } : null,
  };
  return JSON.stringify(normalized);
}

export class SearchQueryTracker {
  private records: QueryRecord[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = MAX_TRACKED_QUERIES) {
    this.maxEntries = maxEntries;
  }

  /**
   * Record a search query occurrence with a timestamp.
   */
  recordQuery(query: MarketplaceSearchQuery, timestamp = Date.now()): void {
    const key = generateQueryKey(query);
    this.records.push({ query, key, timestamp });
    this.trimBuffer(timestamp);
  }

  /**
   * Get top N queries from the last 24 hours ranked by occurrence frequency.
   */
  getTopQueries(topN = 10, now = Date.now()): MarketplaceSearchQuery[] {
    const cutoff = now - TWENTY_FOUR_HOURS_MS;
    const recentRecords = this.records.filter((r) => r.timestamp >= cutoff);

    // Frequency count map
    const frequencyMap = new Map<string, { count: number; query: MarketplaceSearchQuery }>();

    for (const record of recentRecords) {
      const existing = frequencyMap.get(record.key);
      if (existing) {
        existing.count += 1;
      } else {
        frequencyMap.set(record.key, { count: 1, query: record.query });
      }
    }

    // Sort by count descending, tie-break by key ascending
    const sorted = Array.from(frequencyMap.values()).sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return generateQueryKey(a.query).localeCompare(generateQueryKey(b.query));
    });

    return sorted.slice(0, topN).map((item) => item.query);
  }

  /**
   * Clear tracked query history.
   */
  clear(): void {
    this.records = [];
  }

  /**
   * Get total number of stored records.
   */
  size(): number {
    return this.records.length;
  }

  /**
   * Trim records older than 24 hours or exceeding capacity bounds.
   */
  private trimBuffer(now: number): void {
    const cutoff = now - TWENTY_FOUR_HOURS_MS;
    this.records = this.records.filter((r) => r.timestamp >= cutoff);

    if (this.records.length > this.maxEntries) {
      // Remove oldest entries if exceeding maxEntries capacity
      this.records = this.records.slice(this.records.length - this.maxEntries);
    }
  }
}

export interface WarmupOptions {
  topN?: number;
  pacerDelayMs?: number;
  clock?: () => number;
}

export interface WarmupResult {
  total: number;
  warmed: number;
  failed: number;
  coverage: number;
  status: "success" | "partial" | "failed" | "cancelled";
}

export class SearchCacheWarmupService {
  private activeSequence = 0;
  private readonly searchService: SearchServiceInterface;
  private readonly cache?: CacheLayer;
  private readonly queryTracker: SearchQueryTracker;
  private readonly topN: number;
  private readonly pacerDelayMs: number;
  private readonly clock: () => number;

  constructor(
    searchService: SearchServiceInterface,
    queryTracker: SearchQueryTracker,
    cache?: CacheLayer,
    options: WarmupOptions = {}
  ) {
    this.searchService = searchService;
    this.queryTracker = queryTracker;
    this.cache = cache;
    this.topN = options.topN ?? 10;
    this.pacerDelayMs = options.pacerDelayMs ?? 20;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Taxonomy commit hook.
   * Invalidates search caches and replays top queries with low-rate pacing.
   */
  async commitTaxonomy(taxonomyData?: unknown): Promise<WarmupResult> {
    this.activeSequence += 1;
    const currentSeq = this.activeSequence;
    const startTimestamp = this.clock();

    // Step 1: Invalidate search caches
    this.invalidateSearchCache();

    // Step 2: Fetch top-N queries from last 24h
    const topQueries = this.queryTracker.getTopQueries(this.topN, startTimestamp);

    // Edge Case: Low-traffic tenant (0 queries in last 24h)
    if (topQueries.length === 0) {
      recordWarmupCoverage(1.0);
      recordWarmupExecution("success");
      recordWarmupDuration(0);
      return {
        total: 0,
        warmed: 0,
        failed: 0,
        coverage: 1.0,
        status: "success",
      };
    }

    let warmedCount = 0;
    let failedCount = 0;

    // Step 3: Replay queries sequentially with rate pacing
    for (let i = 0; i < topQueries.length; i++) {
      // Edge Case: Rapid taxonomy edits (check if cancelled by newer commit)
      if (this.activeSequence !== currentSeq) {
        recordWarmupExecution("cancelled");
        return {
          total: topQueries.length,
          warmed: warmedCount,
          failed: failedCount,
          coverage: warmedCount / topQueries.length,
          status: "cancelled",
        };
      }

      const query = topQueries[i];

      try {
        // Replay query to populate cache
        await this.searchService.search(query, this.cache);
        warmedCount += 1;
        recordWarmupQueryReplayed("success");
      } catch (err: any) {
        // Edge Case: Warmup mid-outage (catch errors gracefully per query)
        failedCount += 1;
        recordWarmupQueryReplayed("failure");
        console.warn(
          `[searchCacheWarmup] Query replay failed during warmup: ${err?.message || err}`
        );
      }

      // Low-rate pacing delay between query replays
      if (this.pacerDelayMs > 0 && i < topQueries.length - 1) {
        await this.sleep(this.pacerDelayMs);
      }
    }

    // Check again if cancelled before final metric recording
    if (this.activeSequence !== currentSeq) {
      recordWarmupExecution("cancelled");
      return {
        total: topQueries.length,
        warmed: warmedCount,
        failed: failedCount,
        coverage: warmedCount / topQueries.length,
        status: "cancelled",
      };
    }

    const coverage = warmedCount / topQueries.length;
    const durationSeconds = (this.clock() - startTimestamp) / 1000;
    const status: WarmupResult["status"] =
      failedCount === 0 ? "success" : warmedCount > 0 ? "partial" : "failed";

    recordWarmupCoverage(coverage);
    recordWarmupExecution(status);
    recordWarmupDuration(durationSeconds);

    return {
      total: topQueries.length,
      warmed: warmedCount,
      failed: failedCount,
      coverage,
      status,
    };
  }

  /**
   * Invalidate search cache using available cache methods.
   */
  private invalidateSearchCache(): void {
    if (!this.cache) return;

    if (typeof this.cache.invalidateByPrefix === "function") {
      this.cache.invalidateByPrefix("marketplace:search:");
    } else if (typeof this.cache.clear === "function") {
      this.cache.clear();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
