/**
 * Marketplace Search Service
 *
 * Implements deterministic ranking and filtering for slots with optional caching.
 * Uses parameterized queries to prevent SQL injection.
 * Implements stable pagination via tiebreaker by id.
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
  cacheSource?: "hit" | "miss";
}

export class MarketplaceSearchService {
  constructor(private pool: Pool) {}

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
      // Build query components
      const { whereClause, params: filterParams } = this.buildFilterClause(query);
      const orderByClause = this.buildOrderByClause(query);

      // Get total count of matching slots (without pagination)
      const countQuery = `SELECT COUNT(*) as total FROM slots ${whereClause}`;
      const countResult = await this.pool.query(countQuery, filterParams);
      const total = parseInt(countResult.rows[0].total, 10);

      // Calculate pagination
      const offset = (query.page - 1) * query.limit;

      // Build main query with pagination
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
        ${whereClause}
        ${orderByClause}
        LIMIT $${filterParams.length + 1}
        OFFSET $${filterParams.length + 2}
      `;

      const mainParams = [...filterParams, query.limit, offset];
      const result = await this.pool.query(mainQuery, mainParams);

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

      const searchResult: SearchResult = {
        slots,
        data: slots,
        page: query.page,
        limit: query.limit,
        total,
        ranking: query.sortBy,
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
      // Map database errors to appropriate HTTP status
      if (error instanceof Error) {
        // Check for constraint violations or validation errors
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
