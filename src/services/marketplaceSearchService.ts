// @ts-nocheck
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


  NUM_FEATURES,
} from "./ltr/index.js";
import { isFeatureEnabled } from "../flags/index.js";
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

export class MarketplaceSearchService {
  private facetCache: FacetCountsCache;
  private diversificationConfig: Required<DiversificationConfig>;
  private reranker: LtrReranker | undefined;
  private eventEmitter: LtrEventEmitter | undefined;

  constructor(
    private pool: Pool,
    private queryTracker?: SearchQueryTracker,
    facetCache?: FacetCountsCache,
    diversificationConfig: DiversificationConfig = {}
  ) {
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
      const data = JSON.parse(raw);

      if (typeof data !== "object" || data === null) {
        throw new Error("Cursor payload must be an object");
      }

      if (typeof data.id !== "number" || !Number.isInteger(data.id) || data.id < 0) {
        throw new Error("Cursor id must be a non-negative integer");
      }

      if (data.sortBy !== expectedSortBy) {
        throw new Error(`Cursor sortBy mismatch (expected ${expectedSortBy}, got ${data.sortBy})`);
      }

      if (expectedSortBy === "rating" || expectedSortBy === "relevance") {
        if (typeof data.rating !== "number" || isNaN(data.rating)) {
          throw new Error("Cursor rating must be a valid number");
        }
      }

      if (expectedSortBy === "price" || expectedSortBy === "relevance") {
        if (typeof data.price !== "number" || isNaN(data.price)) {
          throw new Error("Cursor price must be a valid number");
        }
      }

      return {
        sortBy: data.sortBy,
        id: data.id,
        rating: data.rating,
        price: data.price,
      };
    } catch (error: any) {
      if (error instanceof MarketplaceSearchError) {
        throw error;
      }
      throw new MarketplaceSearchError(error.message || "Invalid or malformed cursor", 400);
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

    const remaining = slots.map((s, i) => ({ slot: s, originalIndex: i }));
    const result: typeof remaining = [];
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
    const bySortMode = this.diversificationConfig.capBySortMode[query.sortBy];
    if (bySortMode !== undefined) {
      return bySortMode;
    }
    return this.diversificationConfig.defaultCap;
  }

  /**
   * Build SQL WHERE clause and parameters for search filters.
   * Uses parameterized queries to prevent SQL injection.
   */
  private buildFilterClause(query: MarketplaceSearchQuery): {
    whereClause: string;
    params: any[];
    paramCount: number;
  } {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramCount = 1;

    if (query.categories && query.categories.length > 0) {
      const placeholders = query.categories
        .map(() => `$${paramCount++}`)
        .join(", ");
      conditions.push(`category IN (${placeholders})`);
      params.push(...query.categories);
    }

    if (query.priceRange) {
      if (query.priceRange.min !== undefined) {
        conditions.push(`price_cents >= $${paramCount++}`);
        params.push(query.priceRange.min);
      }
      if (query.priceRange.max !== undefined) {
        conditions.push(`price_cents <= $${paramCount++}`);
        params.push(query.priceRange.max);
      }
    }

    if (query.ratingRange) {
      if (query.ratingRange.min !== undefined) {
        conditions.push(`supplier_rating >= $${paramCount++}`);
        params.push(query.ratingRange.min);
      }
      if (query.ratingRange.max !== undefined) {
        conditions.push(`supplier_rating <= $${paramCount++}`);
        params.push(query.ratingRange.max);
      }
    }

    if (query.timeWindow) {
      if (query.timeWindow.startTime !== undefined) {
        const startTimestamp = new Date(query.timeWindow.startTime).toISOString();
        conditions.push(`start_time >= $${paramCount++}`);
        params.push(startTimestamp);
      }
      if (query.timeWindow.endTime !== undefined) {
        const endTimestamp = new Date(query.timeWindow.endTime).toISOString();
        conditions.push(`end_time <= $${paramCount++}`);
        params.push(endTimestamp);
      }
    }

    conditions.push(`status = $${paramCount++}`);
    params.push("available");

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
    return { whereClause, params, paramCount };
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
   */
  private buildCursorPredicate(
    cursorData: CursorData,
    startParamIndex: number
  ): { conditionSql: string; cursorParams: any[]; nextParamIndex: number } {
    let p = startParamIndex;
    const cursorParams: any[] = [];

    switch (cursorData.sortBy) {
      case "rating": {
        const pRating = `$${p++}`;
        const pId = `$${p++}`;
        cursorParams.push(cursorData.rating, cursorData.id);
        const conditionSql = `(supplier_rating < ${pRating} OR (supplier_rating = ${pRating} AND id > ${pId}))`;
        return { conditionSql, cursorParams, nextParamIndex: p };
      }
      case "price": {
        const pPrice = `$${p++}`;
        const pId = `$${p++}`;
        cursorParams.push(cursorData.price, cursorData.id);
        const conditionSql = `(price_cents > ${pPrice} OR (price_cents = ${pPrice} AND id > ${pId}))`;
        return { conditionSql, cursorParams, nextParamIndex: p };
      }
      case "relevance":
      default: {
        const pRating = `$${p++}`;
        const pPrice = `$${p++}`;
        const pId = `$${p++}`;
        cursorParams.push(cursorData.rating, cursorData.price, cursorData.id);
        const conditionSql = `(supplier_rating < ${pRating} OR (supplier_rating = ${pRating} AND price_cents > ${pPrice}) OR (supplier_rating = ${pRating} AND price_cents = ${pPrice} AND id > ${pId}))`;
        return { conditionSql, cursorParams, nextParamIndex: p };
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

    try {
      const { whereClause: baseWhereClause, params: filterParams, paramCount } = this.buildFilterClause(query);
      const orderByClause = this.buildOrderByClause(query);

      const countQuery = `SELECT COUNT(*) as total FROM slots ${baseWhereClause}`;
      const countResult = await this.pool.query(countQuery, filterParams);
      const total = parseInt(countResult.rows[0].total, 10);

      let mainWhereClause = baseWhereClause;
      const mainQueryParams = [...filterParams];
      let currentParamIndex = paramCount;

      if (query.cursor) {
        const cursorData = this.decodeCursor(query.cursor, query.sortBy);
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

      const result = await this.pool.query(mainQuery, mainQueryParams);

      const slots: Slot[] = result.rows.map((row) => ({
        id: row.id,
        professional: row.professional,
        startTime: new Date(row.startTime).getTime(),
        endTime: new Date(row.endTime).getTime(),
        category: row.category,
        price_cents: row.price_cents,
        supplier_rating: row.supplier_rating,
        // Only present when suppressHeld=false AND showHeldReleaseEta=true
        ...(row.held_release_eta != null
          ? { heldReleaseEta: new Date(row.held_release_eta).getTime() }
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
        nextCursor = this.encodeCursor(lastSlot, query.sortBy);
      }

      let facets: FacetCounts | undefined;
      if (query.includeFacets) {
        try {
          facets = await this.facetCache.getFacetCounts(query, this.pool);
        } catch (err) {
          console.warn("Failed to compute facet counts:", err instanceof Error ? err.message : err);
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
        await cache.set(cacheKey, searchResult, ttlMs).catch((err) => {
          console.warn("Failed to cache marketplace search result:", err.message);
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

  private extractFeatureVectors(
    slots: Slot[],
    query: MarketplaceSearchQuery,
  ) {
    const now = Date.now();
    const queryCategorySet = new Set(query.categories ?? []);

    return slots.map((slot) => {
      const features = new Array(NUM_FEATURES).fill(0);

      features[0] = Math.min(1, Math.max(0, (slot.supplier_rating ?? 0) / 5));

      const MAX_PRICE = 20_000;
      features[1] = 1 - Math.min(1, Math.max(0, (slot.price_cents ?? 0) / MAX_PRICE));

      features[2] = 0;

      if (queryCategorySet.size > 0 && slot.category) {
        features[3] = queryCategorySet.has(slot.category) ? 1 : 0;
      }

      const createdTime = (slot as any).created_at
        ? new Date((slot as any).created_at).getTime()
        : null;
      if (createdTime) {
        const daysSinceCreation = (now - createdTime) / (1000 * 60 * 60 * 24);
        features[4] = Math.max(0, 1 - daysSinceCreation / 30);
      }

      const slotTime = slot.startTime ?? now;
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
