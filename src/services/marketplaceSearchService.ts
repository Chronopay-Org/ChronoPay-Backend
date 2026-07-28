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

export interface SearchResult {
  slots: Slot[];
  data: Slot[];
  page: number;
  limit: number;
  total: number;
  ranking: string;
  nextCursor?: string | null;
  cacheSource?: "hit" | "miss";
}

export interface CursorData {
  sortBy: "rating" | "price" | "relevance";
  rating?: number;
  price?: number;
  id: number;
}

export class MarketplaceSearchService {
  constructor(private pool: Pool) {}

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
      throw new MarketplaceSearchError(error.message || "Invalid or malformed cursor", 400);
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

      // Compute nextCursor if page returned full limit
      let nextCursor: string | null = null;
      if (slots.length === query.limit) {
        const lastSlot = slots[slots.length - 1];
        nextCursor = this.encodeCursor(lastSlot, query.sortBy);
      }

      const searchResult: SearchResult = {
        slots,
        data: slots,
        page: query.page,
        limit: query.limit,
        total,
        ranking: query.sortBy,
        nextCursor,
        cacheSource: "miss",
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
