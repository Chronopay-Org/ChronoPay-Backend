import { Pool } from "pg";
import { MarketplaceSearchQuery } from "../validation/marketplaceSearchSchema.js";
import { InMemoryCache } from "./inMemoryCache.js";

export interface FacetCounts {
  categories: Record<string, number>;
  priceRanges: { min: number; max: number; label: string; count: number }[];
  ratingRanges: { min: number; max: number; label: string; count: number }[];
  totalMatching: number;
  /** Unix ms timestamp of last write to this cache entry */
  lastRefreshedAt: number;
  /** Whether this result was refreshed within the freshness window */
  fresh: boolean;
}

export interface FacetFilterSignature {
  categories: string[];
  hasPriceRange: boolean;
  hasRatingRange: boolean;
  hasTimeWindow: boolean;
}

export interface FacetCacheWriteEvent {
  slotId: number;
  eventType: "create" | "update" | "delete";
  oldCategory?: string;
  newCategory?: string;
  oldPriceCents?: number;
  newPriceCents?: number;
  oldRating?: number;
  newRating?: number;
  timestamp: number;
}

const DEFAULT_PRICE_RANGES = [
  { min: 0, max: 5000, label: "Under $50" },
  { min: 5000, max: 15000, label: "$50 – $150" },
  { min: 15000, max: 50000, label: "$150 – $500" },
  { min: 50000, max: 100000, label: "$500 – $1000" },
  { min: 100000, max: Infinity, label: "Over $1000" },
];

const DEFAULT_RATING_RANGES = [
  { min: 4.5, max: 5.0, label: "4.5+ stars" },
  { min: 4.0, max: 4.5, label: "4.0 – 4.5 stars" },
  { min: 3.5, max: 4.0, label: "3.5 – 4.0 stars" },
  { min: 3.0, max: 3.5, label: "3.0 – 3.5 stars" },
  { min: 0.0, max: 3.0, label: "Below 3.0 stars" },
];

const FRESHNESS_WINDOW_MS = 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

export function buildFacetCacheKey(query: MarketplaceSearchQuery): string {
  const sig: FacetFilterSignature = {
    categories: query.categories ? [...query.categories].sort() : [],
    hasPriceRange: !!query.priceRange,
    hasRatingRange: !!query.ratingRange,
    hasTimeWindow: !!query.timeWindow,
  };
  return `facet:counts:${Buffer.from(JSON.stringify(sig)).toString("base64url")}`;
}

export class FacetCountsCache {
  private cache: InMemoryCache<FacetCounts>;
  private writeEvents: FacetCacheWriteEvent[] = [];
  private maxWriteEvents = 10000;
  private pool: Pool | null = null;

  constructor(pool?: Pool, options?: { ttlMs?: number; maxEntries?: number }) {
    this.cache = new InMemoryCache<FacetCounts>({
      ttlMs: options?.ttlMs ?? CACHE_TTL_MS,
      maxEntries: options?.maxEntries ?? MAX_CACHE_ENTRIES,
    });
    if (pool) {
      this.pool = pool;
    }
  }

  setPool(pool: Pool): void {
    this.pool = pool;
  }

  recordWriteEvent(event: Omit<FacetCacheWriteEvent, "timestamp">): void {
    const fullEvent: FacetCacheWriteEvent = {
      ...event,
      timestamp: Date.now(),
    };
    this.writeEvents.push(fullEvent);
    if (this.writeEvents.length > this.maxWriteEvents) {
      this.writeEvents = this.writeEvents.slice(-this.maxWriteEvents);
    }
  }

  recordSlotCreated(args: {
    slotId: number;
    category?: string;
    priceCents?: number;
    rating?: number;
  }): void {
    this.recordWriteEvent({
      slotId: args.slotId,
      eventType: "create",
      newCategory: args.category,
      newPriceCents: args.priceCents,
      newRating: args.rating,
    });
  }

  recordSlotUpdated(args: {
    slotId: number;
    oldCategory?: string;
    newCategory?: string;
    oldPriceCents?: number;
    newPriceCents?: number;
    oldRating?: number;
    newRating?: number;
  }): void {
    this.recordWriteEvent({
      slotId: args.slotId,
      eventType: "update",
      oldCategory: args.oldCategory,
      newCategory: args.newCategory,
      oldPriceCents: args.oldPriceCents,
      newPriceCents: args.newPriceCents,
      oldRating: args.oldRating,
      newRating: args.newRating,
    });
  }

  recordSlotDeleted(args: {
    slotId: number;
    category?: string;
    priceCents?: number;
    rating?: number;
  }): void {
    this.recordWriteEvent({
      slotId: args.slotId,
      eventType: "delete",
      oldCategory: args.category,
      oldPriceCents: args.priceCents,
      oldRating: args.rating,
    });
  }

  private applyWriteEvents(baseCounts: FacetCounts, sinceMs: number): FacetCounts {
    const events = this.writeEvents.filter((e) => e.timestamp >= sinceMs);
    if (events.length === 0) {
      return baseCounts;
    }

    const result: FacetCounts = {
      ...baseCounts,
      categories: { ...baseCounts.categories },
      priceRanges: baseCounts.priceRanges.map((r) => ({ ...r })),
      ratingRanges: baseCounts.ratingRanges.map((r) => ({ ...r })),
    };

    for (const event of events) {
      this.applySingleEvent(result, event);
    }

    result.lastRefreshedAt = Math.max(
      ...events.map((e) => e.timestamp),
      baseCounts.lastRefreshedAt,
    );
    return result;
  }

  private applySingleEvent(counts: FacetCounts, event: FacetCacheWriteEvent): void {
    const {
      eventType,
      oldCategory,
      newCategory,
      oldPriceCents,
      newPriceCents,
      oldRating,
      newRating,
    } = event;

    const decrementCategory = (cat?: string) => {
      if (cat && counts.categories[cat] !== undefined) {
        counts.categories[cat] = Math.max(0, counts.categories[cat] - 1);
        counts.totalMatching = Math.max(0, counts.totalMatching - 1);
      }
    };

    const incrementCategory = (cat?: string) => {
      if (cat) {
        counts.categories[cat] = (counts.categories[cat] || 0) + 1;
        counts.totalMatching += 1;
      }
    };

    const decrementPrice = (price?: number) => {
      if (price !== undefined) {
        const range = counts.priceRanges.find((r) => price >= r.min && price < r.max);
        if (range) range.count = Math.max(0, range.count - 1);
      }
    };

    const incrementPrice = (price?: number) => {
      if (price !== undefined) {
        const range = counts.priceRanges.find((r) => price >= r.min && price < r.max);
        if (range) range.count += 1;
      }
    };

    const decrementRating = (rating?: number) => {
      if (rating !== undefined) {
        const range = counts.ratingRanges.find((r) => rating >= r.min && rating < r.max);
        if (range) range.count = Math.max(0, range.count - 1);
      }
    };

    const incrementRating = (rating?: number) => {
      if (rating !== undefined) {
        const range = counts.ratingRanges.find((r) => rating >= r.min && rating < r.max);
        if (range) range.count += 1;
      }
    };

    switch (eventType) {
      case "create":
        incrementCategory(newCategory);
        incrementPrice(newPriceCents);
        incrementRating(newRating);
        break;

      case "delete":
        decrementCategory(oldCategory);
        decrementPrice(oldPriceCents);
        decrementRating(oldRating);
        break;

      case "update":
        if (oldCategory !== newCategory) {
          decrementCategory(oldCategory);
          incrementCategory(newCategory);
        }
        if (oldPriceCents !== newPriceCents) {
          decrementPrice(oldPriceCents);
          incrementPrice(newPriceCents);
        }
        if (oldRating !== newRating) {
          decrementRating(oldRating);
          incrementRating(newRating);
        }
        break;
    }
  }

  async computeFacetCountsFromDb(query: MarketplaceSearchQuery, pool: Pool): Promise<FacetCounts> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramCount = 1;

    if (query.categories && query.categories.length > 0) {
      const placeholders = query.categories.map(() => `$${paramCount++}`).join(", ");
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
        conditions.push(`start_time >= $${paramCount++}`);
        params.push(new Date(query.timeWindow.startTime).toISOString());
      }
      if (query.timeWindow.endTime !== undefined) {
        conditions.push(`end_time <= $${paramCount++}`);
        params.push(new Date(query.timeWindow.endTime).toISOString());
      }
    }

    conditions.push(`status = $${paramCount++}`);
    params.push("available");

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const categoryQuery = `
      SELECT category, COUNT(*) as cnt FROM slots
      ${whereClause} AND category IS NOT NULL
      GROUP BY category
    `;

    const priceQuery = `
      SELECT price_cents FROM slots ${whereClause} AND price_cents IS NOT NULL
    `;

    const ratingQuery = `
      SELECT supplier_rating FROM slots ${whereClause} AND supplier_rating IS NOT NULL
    `;

    const totalQuery = `
      SELECT COUNT(*) as total FROM slots ${whereClause}
    `;

    const [catResult, priceResult, ratingResult, totalResult] = await Promise.all([
      pool.query(categoryQuery, params),
      pool.query(priceQuery, params),
      pool.query(ratingQuery, params),
      pool.query(totalQuery, params),
    ]);

    const categories: Record<string, number> = {};
    for (const row of catResult.rows) {
      categories[row.category] = parseInt(row.cnt, 10);
    }

    const priceRanges = DEFAULT_PRICE_RANGES.map((r) => ({ ...r, count: 0 }));
    for (const row of priceResult.rows) {
      const price = Number(row.price_cents);
      const range = priceRanges.find((r) => price >= r.min && price < r.max);
      if (range) range.count += 1;
    }

    const ratingRanges = DEFAULT_RATING_RANGES.map((r) => ({ ...r, count: 0 }));
    for (const row of ratingResult.rows) {
      const rating = Number(row.supplier_rating);
      const range = ratingRanges.find((r) => rating >= r.min && rating < r.max);
      if (range) range.count += 1;
    }

    const totalMatching = parseInt(totalResult.rows[0]?.total || "0", 10);
    const now = Date.now();

    return {
      categories,
      priceRanges,
      ratingRanges,
      totalMatching,
      lastRefreshedAt: now,
      fresh: true,
    };
  }

  async getFacetCounts(query: MarketplaceSearchQuery, pool?: Pool): Promise<FacetCounts> {
    const dbPool = pool ?? this.pool;
    const cacheKey = buildFacetCacheKey(query);
    const now = Date.now();
    const cached = this.cache.get(cacheKey);

    if (cached) {
      const age = now - cached.lastRefreshedAt;
      if (age < FRESHNESS_WINDOW_MS) {
        return { ...cached, fresh: true };
      }

      const withWrites = this.applyWriteEvents(cached, cached.lastRefreshedAt);
      const writeAge = now - withWrites.lastRefreshedAt;
      if (writeAge < FRESHNESS_WINDOW_MS) {
        withWrites.fresh = true;
        return withWrites;
      }
    }

    if (!dbPool) {
      return this.buildEmptyFacetCounts();
    }

    const freshCounts = await this.computeFacetCountsFromDb(query, dbPool);
    this.cache.set(cacheKey, freshCounts, CACHE_TTL_MS);
    return freshCounts;
  }

  invalidateAll(): void {
    this.cache.clear();
    this.writeEvents = [];
  }

  invalidateForQuery(query: MarketplaceSearchQuery): boolean {
    const key = buildFacetCacheKey(query);
    return this.cache.invalidate(key);
  }

  getWriteEventCount(): number {
    return this.writeEvents.length;
  }

  private buildEmptyFacetCounts(): FacetCounts {
    return {
      categories: {},
      priceRanges: DEFAULT_PRICE_RANGES.map((r) => ({ ...r, count: 0 })),
      ratingRanges: DEFAULT_RATING_RANGES.map((r) => ({ ...r, count: 0 })),
      totalMatching: 0,
      lastRefreshedAt: Date.now(),
      fresh: true,
    };
  }

  static getDefaultPriceRanges() {
    return DEFAULT_PRICE_RANGES.map((r) => ({ ...r }));
  }

  static getDefaultRatingRanges() {
    return DEFAULT_RATING_RANGES.map((r) => ({ ...r }));
  }

  static get FRESHNESS_WINDOW_MS() {
    return FRESHNESS_WINDOW_MS;
  }
}

export const defaultFacetCountsCache = new FacetCountsCache();
