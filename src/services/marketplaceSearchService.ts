/**
 * Marketplace Search Service
 *
 * Implements deterministic ranking and filtering for slots with optional caching.
 * Uses parameterized queries to prevent SQL injection.
 * Implements stable cursor-based pagination via sort key + id tiebreaker.
 *
 * Features:
 * - Cached facet count aggregates (keyed by filter combination)
 * - Incremental facet refresh on slot writes (fresh within 60s)
 * - Result diversification with configurable per-supplier cap
 */

import { Pool } from "pg";
import { Slot } from "../types.js";
import {
  MarketplaceSearchQuery,
  MarketplaceSearchQueryInput,
  validateSearchQuery,
} from "../validation/marketplaceSearchSchema.js";
import {
  LtrEventEmitter,
  LtrReranker,
  NUM_FEATURES,
} from "./ltr/index.js";
import { isFeatureEnabled } from "../flags/index.js";
import {
  computeCandidateCells,
  distanceKm,
  MAX_GEO_CANDIDATES,
} from "./geo/h3GeoIndex.js";
import { FacetCountsCache, type FacetCounts } from "../cache/facetCountsCache.js";


export interface SearchResult {
  slots: Slot[];
  data: Slot[];
  page: number;
  limit: number;
  total: number;
  ranking: string;
  nextCursor?: string | null;
  cacheSource?: "hit" | "miss";
  /** Whether LTR reranking was applied to this result set */
  ltrReranked?: boolean;
  /** Cached facet counts (only when query.includeFacets = true) */
  facets?: FacetCounts;
  /** Whether diversification was applied */
  diversified?: boolean;
  /** Configured per-supplier cap used for diversification */
  supplierCapApplied?: number;
}

import { SearchQueryTracker } from "../cache/searchCacheWarmup.js";
import { logger } from "../utils/logger.js";

export interface CursorData {
  sortBy: "rating" | "price" | "relevance";
  rating?: number;
  price?: number;
  id: number;
}

export interface DiversificationConfig {
  defaultCap?: number;
  capBySortMode?: Record<"rating" | "price" | "relevance", number>;
}

const DEFAULT_DIVERSIFICATION_CONFIG: Required<DiversificationConfig> = {
  defaultCap: 3,
  capBySortMode: {
    rating: 3,
    price: 2,
    relevance: 3,
  },
};

// ---------------------------------------------------------------------------
// SQL parameter builder
// ---------------------------------------------------------------------------

/**
 * Tracks placeholder indices while building a parameterized SQL fragment.
 * Each call to `add` appends a value and returns the `$N` placeholder string.
 * The final `params` array and `nextIndex` are always consistent.
 */
class ParamList {
  readonly params: unknown[] = [];
  private idx: number;

  constructor(startIdx = 1) {
    this.idx = startIdx;
  }

  /** Append a value and return its placeholder (e.g. `$3`). */
  add(value: unknown): string {
    this.params.push(value);
    return `$${this.idx++}`;
  }

  /** Current next index (equals params.length + startIdx). */
  get nextIndex(): number {
    return this.idx;
  }
}

export class MarketplaceSearchService {
  private facetCache: FacetCountsCache;
  private diversificationConfig: Required<DiversificationConfig>;
  private reranker: LtrReranker | undefined;
  private eventEmitter: LtrEventEmitter | undefined;
  private queryTracker: SearchQueryTracker | undefined;

  constructor(
    private pool: Pool,
    queryTrackerOrReranker?: SearchQueryTracker | LtrReranker,
    facetCacheOrEmitter?: FacetCountsCache | LtrEventEmitter,
    diversificationConfig: DiversificationConfig = {}
  ) {
    // The 2nd/3rd constructor slots are duck-typed: legacy callers pass
    // (queryTracker, facetCache), while the LTR-aware callers pass
    // (reranker, eventEmitter). Distinguish by shape so both work.
    const isQueryTracker = (v: unknown): v is SearchQueryTracker =>
      Boolean(v) && "recordQuery" in (v as object);
    const isReranker = (v: unknown): v is LtrReranker =>
      Boolean(v) && "rerank" in (v as object);
    const isFacetCache = (v: unknown): v is FacetCountsCache =>
      Boolean(v) && "getFacetCounts" in (v as object);
    const isEventEmitter = (v: unknown): v is LtrEventEmitter =>
      Boolean(v) && "emitImpression" in (v as object);

    const queryTracker = isQueryTracker(queryTrackerOrReranker) ? queryTrackerOrReranker : undefined;
    const reranker = isReranker(queryTrackerOrReranker) ? queryTrackerOrReranker : undefined;
    const facetCache = isFacetCache(facetCacheOrEmitter) ? facetCacheOrEmitter : undefined;
    const eventEmitter = isEventEmitter(facetCacheOrEmitter) ? facetCacheOrEmitter : undefined;

    this.queryTracker = queryTracker;
    this.reranker = reranker;
    this.eventEmitter = eventEmitter;
    this.facetCache = facetCache ?? new FacetCountsCache(pool);
    this.diversificationConfig = {
      defaultCap: diversificationConfig.defaultCap ?? DEFAULT_DIVERSIFICATION_CONFIG.defaultCap,
      capBySortMode: {
        ...DEFAULT_DIVERSIFICATION_CONFIG.capBySortMode,
        ...(diversificationConfig.capBySortMode ?? {}),
      },
    };
  }

  setReranker(reranker: LtrReranker): void {
    this.reranker = reranker;
  }

  setEventEmitter(emitter: LtrEventEmitter): void {
    this.eventEmitter = emitter;
  }

  setFacetCache(cache: FacetCountsCache): void {
    this.facetCache = cache;
  }

  getFacetCache(): FacetCountsCache {
    return this.facetCache;
  }

  /**
   * Set or update query tracker for recording search queries.
   */
  setQueryTracker(tracker: SearchQueryTracker): void {
    this.queryTracker = tracker;
  }

  /**
   * Encode cursor data into a base64url string.
   *
   * @param slot Last slot in current page
   * @param sortBy Active sort mode
   * @returns Base64url encoded cursor string
   */
  public encodeCursor(slot: Slot, sortBy: "rating" | "price" | "relevance"): string {
    const data: CursorData = {
      sortBy,
      id: slot.id,
    };
    if (sortBy === "rating" || sortBy === "relevance") {
      data.rating = Number(slot.supplier_rating ?? 0);
    }
    if (sortBy === "price" || sortBy === "relevance") {
      data.price = Number(slot.price_cents ?? 0);
    }
    return Buffer.from(JSON.stringify(data)).toString("base64url");
  }

  /**
   * Decode and strictly validate base64 cursor token.
   *
   * @param cursorStr Base64 encoded cursor token
   * @param expectedSortBy Expected sort mode for current search query
   * @returns Validated CursorData
   * @throws MarketplaceSearchError (400) if invalid or malformed
   */
  public decodeCursor(cursorStr: string, expectedSortBy: "rating" | "price" | "relevance"): CursorData {
    if (!cursorStr || typeof cursorStr !== "string") {
      throw new MarketplaceSearchError("Invalid cursor format", 400);
    }

    try {
      const normalizedBase64 = cursorStr.replace(/-/g, "+").replace(/_/g, "/");
      const raw = Buffer.from(normalizedBase64, "base64").toString("utf-8");
      const data: unknown = JSON.parse(raw);

      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error("Cursor payload must be an object");
      }

      const obj = data as Record<string, unknown>;

      if (typeof obj["id"] !== "number" || !Number.isInteger(obj["id"]) || (obj["id"] as number) < 0) {
        throw new Error("Cursor id must be a non-negative integer");
      }

      if (obj["sortBy"] !== expectedSortBy) {
        throw new Error(`Cursor sortBy mismatch (expected ${expectedSortBy}, got ${String(obj["sortBy"])})`);
      }

      if (expectedSortBy === "rating" || expectedSortBy === "relevance") {
        if (typeof obj["rating"] !== "number" || isNaN(obj["rating"] as number)) {
          throw new Error("Cursor rating must be a valid number");
        }
      }

      if (expectedSortBy === "price" || expectedSortBy === "relevance") {
        if (typeof obj["price"] !== "number" || isNaN(obj["price"] as number)) {
          throw new Error("Cursor price must be a valid number");
        }
      }

      return {
        sortBy: obj["sortBy"] as CursorData["sortBy"],
        id: obj["id"] as number,
        rating: typeof obj["rating"] === "number" ? obj["rating"] : undefined,
        price: typeof obj["price"] === "number" ? obj["price"] : undefined,
      };
    } catch (error: unknown) {
      if (error instanceof MarketplaceSearchError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Invalid or malformed cursor";
      throw new MarketplaceSearchError(message, 400);
    }
  }

  /**
   * Diversify results to prevent a single supplier from dominating.
   * Uses a sliding-window approach: for each position, if the supplier
   * would exceed the cap of consecutive occurrences, pick the next best
   * slot from a different supplier.
   *
   * Preserves overall relevance by only reordering when necessary.
   *
   * @param slots Ranked slots in order of relevance
   * @param cap Maximum consecutive results from a single supplier
   * @returns Diversified slot array
   */
  public diversifyResults(slots: Slot[], cap: number): Slot[] {
    if (slots.length <= cap || cap <= 0) {
      return [...slots];
    }

    const remaining: Array<{ slot: Slot; originalIndex: number }> = slots.map((s, i) => ({
      slot: s,
      originalIndex: i,
    }));
    const result: Array<{ slot: Slot; originalIndex: number }> = [];
    const recentSuppliers: string[] = [];

    while (remaining.length > 0) {
      let selectedIdx = -1;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const supplierId = String(candidate.slot.professional ?? "unknown");

        const consecutiveCount = this.countConsecutiveSupplier(recentSuppliers, supplierId);

        if (consecutiveCount < cap) {
          selectedIdx = i;
          break;
        }
      }

      if (selectedIdx === -1) {
        selectedIdx = 0;
      }

      const selected = remaining.splice(selectedIdx, 1)[0];
      result.push(selected);
      recentSuppliers.push(String(selected.slot.professional ?? "unknown"));
      if (recentSuppliers.length > cap * 2) {
        recentSuppliers.shift();
      }
    }

    return result.map((r) => r.slot);
  }

  private countConsecutiveSupplier(recent: string[], supplierId: string): number {
    let count = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i] === supplierId) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  resolveSupplierCap(query: MarketplaceSearchQuery): number {
    if (query.supplierCap !== undefined && query.supplierCap !== null) {
      return query.supplierCap;
    }
    const sortKey = query.sortBy as keyof typeof this.diversificationConfig.capBySortMode;
    const bySortMode = this.diversificationConfig.capBySortMode[sortKey];
    if (bySortMode !== undefined) {
      return bySortMode;
    }
    return this.diversificationConfig.defaultCap;
  }

  /**
   * Build SQL WHERE clause and parameters for search filters.
   * Uses parameterized queries to prevent SQL injection.
   * Returns params typed as `unknown[]` — values are set by this method and
   * consumed by `pool.query` which accepts `any[]`; callers must not mutate
   * the array members.
   */
  private buildFilterClause(query: MarketplaceSearchQuery): {
    whereClause: string;
    params: unknown[];
    paramCount: number;
  } {
    const conditions: string[] = [];
    const list = new ParamList(1);

    if (query.categories && query.categories.length > 0) {
      const placeholders = query.categories.map((cat) => list.add(cat)).join(", ");
      conditions.push(`category IN (${placeholders})`);
    }

    if (query.priceRange) {
      if (query.priceRange.min !== undefined) {
        conditions.push(`price_cents >= ${list.add(query.priceRange.min)}`);
      }
      if (query.priceRange.max !== undefined) {
        conditions.push(`price_cents <= ${list.add(query.priceRange.max)}`);
      }
    }

    if (query.ratingRange) {
      if (query.ratingRange.min !== undefined) {
        conditions.push(`supplier_rating >= ${list.add(query.ratingRange.min)}`);
      }
      if (query.ratingRange.max !== undefined) {
        conditions.push(`supplier_rating <= ${list.add(query.ratingRange.max)}`);
      }
    }

    if (query.timeWindow) {
      if (query.timeWindow.startTime !== undefined) {
        const startTimestamp = new Date(query.timeWindow.startTime).toISOString();
        conditions.push(`start_time >= ${list.add(startTimestamp)}`);
      }
      if (query.timeWindow.endTime !== undefined) {
        const endTimestamp = new Date(query.timeWindow.endTime).toISOString();
        conditions.push(`end_time <= ${list.add(endTimestamp)}`);
      }
    }

    conditions.push(`status = ${list.add("available")}`);

    // Geo-radius prefilter: H3 tile set (fast, indexed). This narrows the
    // candidate rows down to the neighborhood of the query point; the exact
    // radius cutoff is applied afterward via precise great-circle distance
    // on the candidate set (see searchByGeoRadius). gridDisk-based candidate
    // computation is correct across the antimeridian and at the poles since
    // it walks the H3 grid topology rather than a flat lat/lng bounding box.
    if (query.geo) {
      const candidateCells = computeCandidateCells(
        query.geo.lat,
        query.geo.lng,
        query.geo.radiusKm
      );
      conditions.push(`h3_cell_res7 = ANY(${list.add(candidateCells)}::text[])`);
    }
    // Suppress slots that are currently under an active refundable hold.
    // A hold is active when holds.released_at IS NULL and holds.expires_at > NOW().
    // We use NOT EXISTS to keep the main query efficient (avoids a JOIN that
    // would multiply rows when a slot has multiple historical hold records).
    if (query.suppressHeld !== false) {
      conditions.push(
        `NOT EXISTS (
           SELECT 1 FROM slot_holds h
           WHERE h.slot_id = slots.id
             AND h.released_at IS NULL
             AND h.expires_at > NOW()
         )`,
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return { whereClause, params: list.params, paramCount: list.nextIndex };
  }

  /**
   * Build ORDER BY clause for deterministic ranking.
   * Tiebreaker by id ensures stable pagination across requests.
   */
  private buildOrderByClause(query: MarketplaceSearchQuery): string {
    switch (query.sortBy) {
      case "rating":
        return "ORDER BY supplier_rating DESC, id ASC";
      case "price":
        return "ORDER BY price_cents ASC, id ASC";
      case "relevance":
      default:
        return "ORDER BY supplier_rating DESC, price_cents ASC, id ASC";
    }
  }

  /**
   * Build cursor comparison predicate for deterministic pagination.
   *
   * @param cursorData Decoded cursor from the previous page
   * @param startParamIndex The next available `$N` index (1-based)
   * @returns SQL condition, typed parameter values, and the next free index
   */
  private buildCursorPredicate(
    cursorData: CursorData,
    startParamIndex: number
  ): { conditionSql: string; cursorParams: unknown[]; nextParamIndex: number } {
    const list = new ParamList(startParamIndex);

    switch (cursorData.sortBy) {
      case "rating": {
        const pRating = list.add(cursorData.rating);
        const pId = list.add(cursorData.id);
        const conditionSql = `(supplier_rating < ${pRating} OR (supplier_rating = ${pRating} AND id > ${pId}))`;
        return { conditionSql, cursorParams: list.params, nextParamIndex: list.nextIndex };
      }
      case "price": {
        const pPrice = list.add(cursorData.price);
        const pId = list.add(cursorData.id);
        const conditionSql = `(price_cents > ${pPrice} OR (price_cents = ${pPrice} AND id > ${pId}))`;
        return { conditionSql, cursorParams: list.params, nextParamIndex: list.nextIndex };
      }
      case "relevance":
      default: {
        const pRating = list.add(cursorData.rating);
        const pPrice = list.add(cursorData.price);
        const pId = list.add(cursorData.id);
        const conditionSql = `(supplier_rating < ${pRating} OR (supplier_rating = ${pRating} AND price_cents > ${pPrice}) OR (supplier_rating = ${pRating} AND price_cents = ${pPrice} AND id > ${pId}))`;
        return { conditionSql, cursorParams: list.params, nextParamIndex: list.nextIndex };
      }
    }
  }

  /**
   * Search for slots with filters, pagination, facets, and diversification.
   */
  async search(
    rawQuery: MarketplaceSearchQueryInput,
    cache?: {
      get: (key: string) => Promise<SearchResult | null>;
      set: (key: string, value: SearchResult, ttlMs: number) => Promise<void>;
    }
  ): Promise<SearchResult> {
    const query = validateSearchQuery(rawQuery);
    if (this.queryTracker) {
      this.queryTracker.recordQuery(query);
    }

    const cacheKey = this.generateCacheKey(query);

    if (cache) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return { ...cached, cacheSource: "hit" };
      }
    }

    // Geo-radius search uses a dedicated path: the exact radius cutoff and
    // (optional) distance sort can only be applied after fetching candidate
    // rows and computing precise great-circle distance in application code,
    // so it can't reuse the SQL COUNT(*)/cursor-predicate flow below.
    if (query.geo) {
      return this.searchByGeoRadius(query, cache, cacheKey);
    }

    try {
      const { whereClause: baseWhereClause, params: filterParams, paramCount } = this.buildFilterClause(query);
      const orderByClause = this.buildOrderByClause(query);

      const countQuery = `SELECT COUNT(*) as total FROM slots ${baseWhereClause}`;
      const countResult = await this.pool.query(countQuery, filterParams as unknown[]);
      const total = parseInt(countResult.rows[0].total, 10);

      let mainWhereClause = baseWhereClause;
      const mainQueryParams: unknown[] = [...filterParams];
      let currentParamIndex = paramCount;

      if (query.cursor) {
        const cursorData = this.decodeCursor(query.cursor, query.sortBy as "rating" | "price" | "relevance");
        const { conditionSql, cursorParams, nextParamIndex } = this.buildCursorPredicate(
          cursorData,
          currentParamIndex
        );

        if (mainWhereClause.length > 0) {
          mainWhereClause += ` AND ${conditionSql}`;
        } else {
          mainWhereClause = `WHERE ${conditionSql}`;
        }
        mainQueryParams.push(...cursorParams);
        currentParamIndex = nextParamIndex;
      }

      let paginationClause: string;
      if (query.cursor) {
        paginationClause = `LIMIT $${currentParamIndex}`;
        mainQueryParams.push(query.limit);
      } else {
        const offset = (query.page - 1) * query.limit;
        paginationClause = `LIMIT $${currentParamIndex} OFFSET $${currentParamIndex + 1}`;
        mainQueryParams.push(query.limit, offset);
      }

      const mainQuery = `
        SELECT 
          id, 
          professional_id as professional,
          start_time as "startTime",
          end_time as "endTime",
          category,
          price_cents,
          supplier_rating,
          status,
          created_at${query.suppressHeld === false && query.showHeldReleaseEta ? `,
          (
            SELECT h.expires_at
            FROM slot_holds h
            WHERE h.slot_id = slots.id
              AND h.released_at IS NULL
              AND h.expires_at > NOW()
            ORDER BY h.expires_at DESC
            LIMIT 1
          ) AS held_release_eta` : ""}
        FROM slots
        ${mainWhereClause}
        ${orderByClause}
        ${paginationClause}
      `;

      const result = await this.pool.query(mainQuery, mainQueryParams as unknown[]);

      const slots: Slot[] = result.rows.map((row: Record<string, unknown>) => ({
        id: row["id"] as number,
        professional: row["professional"] as string,
        startTime: new Date(row["startTime"] as string | number).getTime(),
        endTime: new Date(row["endTime"] as string | number).getTime(),
        category: row["category"] as string | undefined,
        price_cents: row["price_cents"] as number | undefined,
        supplier_rating: row["supplier_rating"] as number | undefined,
        // Only present when suppressHeld=false AND showHeldReleaseEta=true
        ...(row["held_release_eta"] != null
          ? { heldReleaseEta: new Date(row["held_release_eta"] as string | number).getTime() }
          : {}),
      }));

      let slotsOrdered = slots;
      let ltrReranked = false;

      if (
        this.reranker &&
        isFeatureEnabled("SEARCH_LTR_RERANKER") &&
        this.reranker.isAvailable()
      ) {
        let featureVectors: Array<{ slotId: number; features: number[] }> | undefined;

        try {
          featureVectors = this.extractFeatureVectors(slots, query);
          const rerankResult = this.reranker.rerank(featureVectors);

          if (rerankResult.reranked) {
            const slotMap = new Map(slots.map((s) => [s.id, s]));
            const reranked: Slot[] = [];
            for (const slotId of rerankResult.slotIds) {
              const slot = slotMap.get(slotId);
              if (slot) {
                reranked.push(slot);
              }
            }
            if (reranked.length === slots.length) {
              slotsOrdered = reranked;
              ltrReranked = true;
            }
          }
        } catch {
          // LTR errors are non-fatal; fall back to SQL-ordered results
        }

        if (this.eventEmitter && featureVectors) {
          try {
            const searchId = this.generateSearchId();
            this.eventEmitter.emitImpression({
              type: "search_impression",
              timestamp: new Date().toISOString(),
              searchId,
              query: {
                categories: query.categories,
                priceRange: query.priceRange,
                ratingRange: query.ratingRange,
                sortBy: query.sortBy,
                page: query.page,
              },
              displayedSlots: featureVectors.map((fv) => ({
                slotId: fv.slotId,
                features: fv.features,
              })),
            });
          } catch {
            // Impression event errors are non-fatal
          }
        }
      }

      let diversified = false;
      let supplierCapApplied: number | undefined;
      if (query.diversify && slotsOrdered.length > 1) {
        const cap = this.resolveSupplierCap(query);
        const diversifiedSlots = this.diversifyResults(slotsOrdered, cap);
        if (diversifiedSlots.length === slotsOrdered.length) {
          let changed = false;
          for (let i = 0; i < slotsOrdered.length; i++) {
            if (diversifiedSlots[i].id !== slotsOrdered[i].id) {
              changed = true;
              break;
            }
          }
          slotsOrdered = diversifiedSlots;
          diversified = changed || slotsOrdered.length > cap;
          supplierCapApplied = cap;
        }
      }

      let nextCursor: string | null = null;
      if (slotsOrdered.length === query.limit) {
        const lastSlot = slotsOrdered[slotsOrdered.length - 1];
        nextCursor = this.encodeCursor(lastSlot, query.sortBy as "rating" | "price" | "relevance");
      }

      let facets: FacetCounts | undefined;
      if (query.includeFacets) {
        try {
          facets = await this.facetCache.getFacetCounts(query, this.pool);
        } catch (err) {
          logger.warn({ err }, "Failed to compute facet counts");
        }
      }

      const searchResult: SearchResult = {
        slots: slotsOrdered,
        data: slotsOrdered,
        page: query.page,
        limit: query.limit,
        total,
        ranking: query.sortBy,
        nextCursor,
        cacheSource: "miss",
        ltrReranked: ltrReranked || undefined,
        facets,
        diversified,
        supplierCapApplied,
      };

      if (cache) {
        const ttlMs = 60 * 1000;
        await cache.set(cacheKey, searchResult, ttlMs).catch((err: Error) => {
          logger.warn({ err }, "Failed to cache marketplace search result");
        });
      }

      return searchResult;
    } catch (error) {
      if (error instanceof MarketplaceSearchError) {
        throw error;
      }
      if (error instanceof Error) {
        if (error.message.includes("invalid") || error.message.includes("constraint")) {
          throw new MarketplaceSearchError(
            "Invalid search parameters",
            400,
            error.message
          );
        }
      }
      throw error;
    }
  }

  /**
   * Sort a slot+distance candidate set according to the requested sortBy,
   * with `id` as the final deterministic tiebreaker in every case.
   */
  private sortGeoCandidates(
    candidates: Array<{ slot: Slot; distanceKm: number }>,
    sortBy: MarketplaceSearchQuery["sortBy"]
  ): void {
    candidates.sort((a, b) => {
      switch (sortBy) {
        case "price": {
          const diff = (a.slot.price_cents ?? 0) - (b.slot.price_cents ?? 0);
          if (diff !== 0) return diff;
          break;
        }
        case "rating": {
          const diff = (b.slot.supplier_rating ?? 0) - (a.slot.supplier_rating ?? 0);
          if (diff !== 0) return diff;
          break;
        }
        case "distance": {
          const diff = a.distanceKm - b.distanceKm;
          if (diff !== 0) return diff;
          break;
        }
        case "relevance":
        default: {
          const ratingDiff = (b.slot.supplier_rating ?? 0) - (a.slot.supplier_rating ?? 0);
          if (ratingDiff !== 0) return ratingDiff;
          const priceDiff = (a.slot.price_cents ?? 0) - (b.slot.price_cents ?? 0);
          if (priceDiff !== 0) return priceDiff;
          break;
        }
      }
      return a.slot.id - b.slot.id;
    });
  }

  /**
   * Geo-radius search: H3 tile prefilter (via buildFilterClause) followed by
   * a precise great-circle distance filter/sort on the candidate rows.
   *
   * Notes on scope/trade-offs (see PR description for full rationale):
   *  - Does not support cursor-based pagination (rejected at validation);
   *    only page/limit (offset) pagination is supported for geo queries.
   *  - Does not run LTR reranking; the reranker's feature vectors don't yet
   *    account for distance, so it's intentionally left untouched here.
   *  - The candidate row fetch is capped at MAX_GEO_CANDIDATES as a safety
   *    bound on query cost. Real-world slot density within a ~100km H3 tile
   *    neighborhood is expected to stay well under this cap; if it's
   *    exceeded, results are computed from the first MAX_GEO_CANDIDATES rows
   *    returned by the prefilter rather than the full set.
   */
  private async searchByGeoRadius(
    query: MarketplaceSearchQuery,
    cache:
      | {
          get: (key: string) => Promise<SearchResult | null>;
          set: (key: string, value: SearchResult, ttlMs: number) => Promise<void>;
        }
      | undefined,
    cacheKey: string
  ): Promise<SearchResult> {
    const geo = query.geo;
    /* istanbul ignore next -- guarded by validation schema; defensive only */
    if (!geo) {
      throw new MarketplaceSearchError("geo filter is required for geo-radius search", 400);
    }

    try {
      const { whereClause, params, paramCount } = this.buildFilterClause(query);
      const limitPlaceholder = `$${paramCount}`;
      const candidateQuery = `
        SELECT
          id,
          professional_id as professional,
          start_time as "startTime",
          end_time as "endTime",
          category,
          price_cents,
          supplier_rating,
          status,
          created_at,
          latitude,
          longitude
        FROM slots
        ${whereClause}
        LIMIT ${limitPlaceholder}
      `;
      const result = await this.pool.query(candidateQuery, [...(params as unknown[]), MAX_GEO_CANDIDATES]);

      const candidates: Array<{ slot: Slot; distanceKm: number }> = [];
      for (const row of result.rows as Array<Record<string, unknown>>) {
        const dKm = distanceKm(
          geo.lat,
          geo.lng,
          Number(row["latitude"]),
          Number(row["longitude"])
        );
        if (dKm <= geo.radiusKm) {
          candidates.push({
            slot: {
              id: row["id"] as number,
              professional: row["professional"] as string,
              startTime: new Date(row["startTime"] as string | number).getTime(),
              endTime: new Date(row["endTime"] as string | number).getTime(),
              category: row["category"] as string | undefined,
              price_cents: row["price_cents"] as number | undefined,
              supplier_rating: row["supplier_rating"] as number | undefined,
              latitude: Number(row["latitude"]),
              longitude: Number(row["longitude"]),
            },
            distanceKm: dKm,
          });
        }
      }

      this.sortGeoCandidates(candidates, query.sortBy);

      const total = candidates.length;
      const offset = (query.page - 1) * query.limit;
      const page = candidates.slice(offset, offset + query.limit);

      const slots: Slot[] = page.map(({ slot, distanceKm: d }) => ({
        ...slot,
        distanceKm: Math.round(d * 100) / 100,
      }));

      const searchResult: SearchResult = {
        slots,
        data: slots,
        page: query.page,
        limit: query.limit,
        total,
        ranking: query.sortBy,
        nextCursor: null,
        cacheSource: "miss",
      };

      if (cache) {
        const ttlMs = 60 * 1000;
        await cache.set(cacheKey, searchResult, ttlMs).catch((err: Error) => {
          logger.warn({ err }, "Failed to cache marketplace geo search result");
        });
      }

      return searchResult;
    } catch (error) {
      if (error instanceof MarketplaceSearchError) {
        throw error;
      }
      if (error instanceof Error) {
        if (error.message.includes("invalid") || error.message.includes("constraint")) {
          throw new MarketplaceSearchError("Invalid search parameters", 400, error.message);
        }
      }
      throw error;
    }
  }

  /**
   * Extract feature vectors from slot data for the reranker.
   *
   * Feature meanings:
   *   0: supplier_rating (normalized 0–1)
   *   1: price_cents (inverted & normalized 0–1, cheaper → higher)
   *   2: historical_ctr (cold-start = 0)
   *   3: category_match (1 if query category matches slot category)
   *   4: recency_boost (decays with days since creation)
   *   5: availability_window (1 for near-future slots, decays)
   */
  private extractFeatureVectors(
    slots: Slot[],
    query: MarketplaceSearchQuery,
  ): Array<{ slotId: number; features: number[] }> {
    const now = Date.now();
    const queryCategorySet = new Set(query.categories ?? []);

    return slots.map((slot) => {
      const features = new Array<number>(NUM_FEATURES).fill(0);

      features[0] = Math.min(1, Math.max(0, (slot.supplier_rating ?? 0) / 5));

      const MAX_PRICE = 20_000;
      features[1] = 1 - Math.min(1, Math.max(0, (slot.price_cents ?? 0) / MAX_PRICE));

      features[2] = 0;

      if (queryCategorySet.size > 0 && slot.category) {
        features[3] = queryCategorySet.has(slot.category) ? 1 : 0;
      }

      const slotWithCreatedAt = slot as Slot & { created_at?: unknown };
      const createdTime = slotWithCreatedAt.created_at
        ? new Date(slotWithCreatedAt.created_at as string | number).getTime()
        : null;
      if (createdTime) {
        const daysSinceCreation = (now - createdTime) / (1000 * 60 * 60 * 24);
        features[4] = Math.max(0, 1 - daysSinceCreation / 30);
      }

      const slotTime = typeof slot.startTime === "number" ? slot.startTime : now;
      const hoursUntilSlot = (slotTime - now) / (1000 * 60 * 60);
      features[5] = Math.max(0, 1 - Math.abs(hoursUntilSlot) / (24 * 7));

      return { slotId: slot.id, features };
    });
  }

  private generateSearchId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `srch_${timestamp}_${random}`;
  }

  private generateCacheKey(query: MarketplaceSearchQuery): string {
    const key = {
      page: query.page,
      limit: query.limit,
      cursor: query.cursor ?? null,
      sortBy: query.sortBy,
      categories: query.categories ? [...query.categories].sort() : [],
      priceRange: query.priceRange ? JSON.stringify(query.priceRange) : null,
      ratingRange: query.ratingRange ? JSON.stringify(query.ratingRange) : null,
      timeWindow: query.timeWindow ? JSON.stringify(query.timeWindow) : null,
      geo: query.geo ? JSON.stringify(query.geo) : null,
      includeFacets: query.includeFacets,
      diversify: query.diversify,
      supplierCap: query.supplierCap ?? null,
    };
    return `marketplace:search:${Buffer.from(JSON.stringify(key)).toString("base64")}`;
  }
}

/**
 * Custom error for marketplace search failures.
 * Includes HTTP status code for proper error responses.
 */
export class MarketplaceSearchError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public details?: string
  ) {
    super(message);
    this.name = "MarketplaceSearchError";
  }
}
