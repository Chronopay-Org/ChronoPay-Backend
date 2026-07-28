# Search Cache Warmup Documentation

## Overview

When the tag taxonomy is updated, existing marketplace search cache entries become stale and are invalidated. Without cache warmup, subsequent queries encounter cold-cache latency.

`SearchCacheWarmupService` pre-populates popular queries immediately following tag taxonomy commits.

---

## Architecture & Workflow

1. **Query Logging (`SearchQueryTracker`)**:
   - Every search query executed through `MarketplaceSearchService.search()` is recorded with a timestamp.
   - Queries are normalized by parameters (category lists, price ranges, rating ranges, time windows, pagination, sorting).
   - Frequency rankings are calculated strictly over a sliding **24-hour window**.
   - Capacity is bounded (default 1,000 queries) to prevent memory growth.

2. **Taxonomy Commit Hook (`commitTaxonomy`)**:
   - Triggered when taxonomy edits are committed.
   - Clears/invalidates existing search cache entries.
   - Retrieves the top-N queries (default top 10) from the last 24 hours.
   - Replays queries sequentially with rate pacing.

3. **Rate Pacing & Low-Rate Replayer**:
   - Replays queries with a configurable delay (`pacerDelayMs`, default 20ms) between requests to prevent CPU or database load spikes.

---

## Edge Case Handling

- **Rapid Taxonomy Edits**:
  - Sequence tracking (`activeSequence`) ensures that if a new taxonomy commit occurs while a warmup is in progress, the superseded warmup run is cancelled cleanly before processing remaining queries.

- **Warmup Mid-Outage**:
  - Individual query failures during replay (e.g. database or cache connection drops) are caught per query, logged as warnings, and recorded in failure metrics without crashing the replayer or process.

- **Low-Traffic Tenant**:
  - If zero queries were recorded in the last 24 hours, the warmup finishes immediately with 100% coverage reporting (`coverage: 1.0`, `status: "success"`).

---

## Prometheus Metrics

- `search_cache_warmup_coverage_ratio` (Gauge): Ratio of successfully warmed search queries to target top-N count.
- `search_cache_warmup_total` (Counter, label `status`): Total warmup runs triggered (`success`, `partial`, `failed`, `cancelled`).
- `search_cache_warmup_queries_total` (Counter, label `result`): Count of replayed queries (`success`, `failure`).
- `search_cache_warmup_duration_seconds` (Histogram): Duration of warmup execution runs in seconds.

---

## Usage Example

```ts
import { MarketplaceSearchService } from "./services/marketplaceSearchService.js";
import { SearchQueryTracker, SearchCacheWarmupService } from "./cache/searchCacheWarmup.js";

// Initialize tracker & warmup service
const queryTracker = new SearchQueryTracker();
const searchService = new MarketplaceSearchService(pool, queryTracker);

const warmupService = new SearchCacheWarmupService(searchService, queryTracker, cache, {
  topN: 10,
  pacerDelayMs: 20,
});

// Hook into taxonomy commit
async function onTaxonomyUpdated(taxonomyData: unknown) {
  const result = await warmupService.commitTaxonomy(taxonomyData);
  console.info(`[Warmup] Completed with status=${result.status}, coverage=${result.coverage}`);
}
```
