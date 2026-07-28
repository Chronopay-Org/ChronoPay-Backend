/**
 * Marketplace Search Service
 *
 * Implements deterministic ranking and filtering for slots with optional caching.
 * Uses parameterized queries to prevent SQL injection.
 * Implements stable cursor-based pagination via sort key + id tiebreaker.
 */

import { Pool } from "pg";
import { Slot } from "../types.js";
import { MarketplaceSearchQuery } from "../validation/marketplaceSearchSchema.js";
import {
  type LtrEventEmitter,
  type LtrReranker,
  NUM_FEATURES,
} from "./ltr/index.js";
import { isFeatureEnabled } from "../flags/index.js";

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
}

import { SearchQueryTracker } from "../cache/searchCacheWarmup.js";
export interface CursorData {
  sortBy: "rating" | "price" | "relevance";
  rating?: number;
  price?: number;
  id: number;
}

export class MarketplaceSearchService {
  constructor(
    private pool: Pool,
    private reranker?: LtrReranker,
    private eventEmitter?: LtrEventEmitter,
  ) {}

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
      // Support base64 and base64url encoding formats
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
      throw new MarketplaceSearchError("Invalid or malformed cursor", 400, error.message);
    }
  }

  /**
   * Build SQL WHERE clause and parameters for search filters.
   * Uses parameterized queries to prevent SQL injection.
   *
   * @param query Search query with filters
   * @returns { whereClause, params, paramCount } for constructing query
   */
  private buildFilterClause(query: MarketplaceSearchQuery): {
    whereClause: string;
    params: any[];
    paramCount: number;
  } {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramCount = 1;

    // Filter by categories
    if (query.categories && query.categories.length > 0) {
      const placeholders = query.categories
        .map(() => `$${paramCount++}`)
        .join(", ");
      conditions.push(`category IN (${placeholders})`);
      params.push(...query.categories);
    }

    // Filter by price range (in cents)
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

    // Filter by rating range
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

    // Filter by time window
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

    // Filter by availability
    conditions.push(`status = $${paramCount++}`);
    params.push("available");

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return { whereClause, params, paramCount };
  }

  /**
   * Build ORDER BY clause for deterministic ranking.
   * Tiebreaker by id ensures stable pagination across requests.
   *
   * @param query Search query with sorting preferences
   * @returns ORDER BY clause
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
   * @param cursorData Decoded cursor values
   * @param startParamIndex Starting SQL parameter index ($N)
   * @returns { conditionSql, cursorParams, nextParamIndex }
   */
  private buildCursorPredicate(
    cursorData: CursorData,
    startParamIndex: number
  ): { conditionSql: string; cursorParams: any[]; nextParamIndex: number } {
    let p = startParamIndex;
    const cursorParams: any[] = [];

    switch (cursorData.sortBy) {
      case "rating": {
        // supplier_rating DESC, id ASC
        // (supplier_rating < $p) OR (supplier_rating = $p AND id > $p+1)
        const pRating = `$${p++}`;
        const pId = `$${p++}`;
        cursorParams.push(cursorData.rating, cursorData.id);
        const conditionSql = `(supplier_rating < ${pRating} OR (supplier_rating = ${pRating} AND id > ${pId}))`;
        return { conditionSql, cursorParams, nextParamIndex: p };
      }
      case "price": {
        // price_cents ASC, id ASC
        // (price_cents > $p) OR (price_cents = $p AND id > $p+1)
        const pPrice = `$${p++}`;
        const pId = `$${p++}`;
        cursorParams.push(cursorData.price, cursorData.id);
        const conditionSql = `(price_cents > ${pPrice} OR (price_cents = ${pPrice} AND id > ${pId}))`;
        return { conditionSql, cursorParams, nextParamIndex: p };
      }
      case "relevance":
      default: {
        // supplier_rating DESC, price_cents ASC, id ASC
        // (supplier_rating < $p1)
        // OR (supplier_rating = $p1 AND price_cents > $p2)
        // OR (supplier_rating = $p1 AND price_cents = $p2 AND id > $p3)
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
   * Search for slots with filters and pagination.
   * Returns deterministic results with optional caching.
   *
   * @param query Validated search query
   * @param cache Optional cache layer for hot queries
   * @returns Search results with pagination metadata
   */
  async search(
    query: MarketplaceSearchQuery,
    cache?: {
      get: (key: string) => Promise<SearchResult | null>;
      set: (key: string, value: SearchResult, ttlMs: number) => Promise<void>;
    }
  ): Promise<SearchResult> {
    // Record search query in tracker if configured
    if (this.queryTracker) {
      this.queryTracker.recordQuery(query);
    }

    // Generate cache key from query parameters
    const cacheKey = this.generateCacheKey(query);


    // Try to get from cache first
    if (cache) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return { ...cached, cacheSource: "hit" };
      }
    }

    try {
      // Build filter clauses (excluding cursor)
      const { whereClause: baseWhereClause, params: filterParams, paramCount } = this.buildFilterClause(query);
      const orderByClause = this.buildOrderByClause(query);

      // Get total count of matching slots (without pagination / cursor filtering)
      const countQuery = `SELECT COUNT(*) as total FROM slots ${baseWhereClause}`;
      const countResult = await this.pool.query(countQuery, filterParams);
      const total = parseInt(countResult.rows[0].total, 10);

      let mainWhereClause = baseWhereClause;
      const mainQueryParams = [...filterParams];
      let currentParamIndex = paramCount;

      // Append cursor predicate if cursor is specified
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

      // Build main query with pagination
      let paginationClause: string;
      if (query.cursor) {
        // Cursor pagination does not use OFFSET
        paginationClause = `LIMIT $${currentParamIndex}`;
        mainQueryParams.push(query.limit);
      } else {
        // Standard offset pagination
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
          created_at
        FROM slots
        ${mainWhereClause}
        ${orderByClause}
        ${paginationClause}
      `;

      const result = await this.pool.query(mainQuery, mainQueryParams);

      // Transform database rows to Slot interface
      const slots: Slot[] = result.rows.map((row) => ({
        id: row.id,
        professional: row.professional,
        startTime: new Date(row.startTime).getTime(),
        endTime: new Date(row.endTime).getTime(),
        category: row.category,
        price_cents: row.price_cents,
        supplier_rating: row.supplier_rating,
      }));

      // ── LTR Reranking Stage ──────────────────────────────────────────
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
            // Reorder slots according to the rerank result
            const slotMap = new Map(slots.map((s) => [s.id, s]));
            const reranked: Slot[] = [];
            for (const slotId of rerankResult.slotIds) {
              const slot = slotMap.get(slotId);
              if (slot) {
                reranked.push(slot);
              }
            }
            // Only apply if we have all slots accounted for
            if (reranked.length === slots.length) {
              slotsOrdered = reranked;
              ltrReranked = true;
            }
          }
        } catch {
          // Reranker failure must never fail the search response
          // slotsOrdered remains the original database order, ltrReranked stays false
        }

        // Emit impression event for offline training (fire-and-forget)
        // Separated from the reranker try-catch so emission failures
        // don't invalidate successful reranking.
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
            // Emission failure is non-critical; log and continue
          }
        }
      }

      // Compute nextCursor if page returned full limit
      let nextCursor: string | null = null;
      if (slotsOrdered.length === query.limit) {
        const lastSlot = slotsOrdered[slotsOrdered.length - 1];
        nextCursor = this.encodeCursor(lastSlot, query.sortBy);
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
      };

      // Cache the result if cache is available
      if (cache) {
        const ttlMs = 60 * 1000; // 60 second TTL for hot queries
        await cache.set(cacheKey, searchResult, ttlMs).catch((err) => {
          // Log cache errors but don't fail the request
          console.warn("Failed to cache marketplace search result:", err.message);
        });
      }

      return searchResult;
    } catch (error) {
      if (error instanceof MarketplaceSearchError) {
        throw error;
      }
      // Map database errors to appropriate HTTP status
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
  ) {
    const now = Date.now();
    const queryCategorySet = new Set(query.categories ?? []);

    return slots.map((slot) => {
      const features = new Array(NUM_FEATURES).fill(0);

      // [0] supplier_rating: normalized 0–1
      features[0] = Math.min(1, Math.max(0, (slot.supplier_rating ?? 0) / 5));

      // [1] price_cents: inverted & normalized (cheaper = higher score)
      const MAX_PRICE = 20_000;
      features[1] = 1 - Math.min(1, Math.max(0, (slot.price_cents ?? 0) / MAX_PRICE));

      // [2] historical_ctr: not available at query time → 0
      features[2] = 0;

      // [3] category_match: 1 if any query category matches
      if (queryCategorySet.size > 0 && slot.category) {
        features[3] = queryCategorySet.has(slot.category) ? 1 : 0;
      }

      // [4] recency_boost: 1 for slots created recently, decays over 30 days
      const createdTime = (slot as any).created_at
        ? new Date((slot as any).created_at).getTime()
        : null;
      if (createdTime) {
        const daysSinceCreation = (now - createdTime) / (1000 * 60 * 60 * 24);
        features[4] = Math.max(0, 1 - daysSinceCreation / 30);
      }

      // [5] availability_window: 1 for near-future slots, decays with distance
      const slotTime = slot.startTime ?? now;
      const hoursUntilSlot = (slotTime - now) / (1000 * 60 * 60);
      features[5] = Math.max(0, 1 - Math.abs(hoursUntilSlot) / (24 * 7));

      return { slotId: slot.id, features };
    });
  }

  /**
   * Generate a unique search ID for correlating impression→click events.
   */
  private generateSearchId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `srch_${timestamp}_${random}`;
  }

  /**
   * Generate a deterministic cache key from search query.
   * Ensures cache hits for identical queries.
   *
   * @param query Search query
   * @returns Cache key string
   */
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
