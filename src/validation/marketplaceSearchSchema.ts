/**
 * Schema and validators for marketplace slot search endpoint.
 *
 * Enforces strict input validation with size caps on filter arrays
 * to prevent resource exhaustion attacks.
 */

import { z } from "zod";
import { MAX_RADIUS_KM } from "../services/geo/h3GeoIndex.js";

// ─── Constants ──────────────────────────────────────────────────────────────
const MAX_CATEGORIES = 10;
const MAX_RESULTS = 100;
const MIN_RESULTS = 1;
const MAX_SUPPLIER_CAP = 20;
const MIN_SUPPLIER_CAP = 1;

// ─── Zod Schemas ───────────────────────────────────────────────────────────

/**
 * Single price range filter: { min: number, max: number }
 * Both in cents, non-negative, max must be >= min
 */
const PriceRangeSchema = z
  .object({
    min: z.number().int().nonnegative("min price must be non-negative").optional(),
    max: z.number().int().nonnegative("max price must be non-negative").optional(),
  })
  .refine((data) => !data.min || !data.max || data.max >= data.min, {
    message: "max price must be >= min price",
    path: ["max"],
  });

/**
 * Rating range filter: { min: number, max: number }
 * Both in range [0, 5], max must be >= min
 */
const RatingRangeSchema = z
  .object({
    min: z.number().min(0, "min rating must be >= 0").max(5, "min rating must be <= 5").optional(),
    max: z.number().min(0, "max rating must be >= 0").max(5, "max rating must be <= 5").optional(),
  })
  .refine((data) => !data.min || !data.max || data.max >= data.min, {
    message: "max rating must be >= min rating",
    path: ["max"],
  });

/**
 * Time window filter: { startTime: timestamp, endTime: timestamp }
 * Represents a time range for when slots should fall
 * endTime must be > startTime
 */
const TimeWindowSchema = z
  .object({
    startTime: z
      .number()
      .int()
      .nonnegative("startTime must be non-negative Unix timestamp")
      .optional(),
    endTime: z.number().int().nonnegative("endTime must be non-negative Unix timestamp").optional(),
  })
  .refine((data) => !data.startTime || !data.endTime || data.endTime > data.startTime, {
    message: "endTime must be > startTime",
    path: ["endTime"],
  });

/**
 * Geo-radius filter: { lat, lng, radiusKm }
 * lat/lng bound to valid WGS84 ranges; radiusKm capped to bound query cost
 * (see MAX_GEO_CANDIDATES in h3GeoIndex.ts for the matching row-count cap).
 */
const GeoFilterSchema = z.object({
  lat: z.number().min(-90, "lat must be >= -90").max(90, "lat must be <= 90"),
  lng: z.number().min(-180, "lng must be >= -180").max(180, "lng must be <= 180"),
  radiusKm: z
    .number()
    .positive("radiusKm must be > 0")
    .max(MAX_RADIUS_KM, `radiusKm must be <= ${MAX_RADIUS_KM}`),
});

/**
 * Main search query schema
 * All filters are optional for flexible searching
 */
export const MarketplaceSearchSchema = z.object({
  // Pagination
  page: z.number().int().min(1, "page must be >= 1").default(1),
  limit: z
    .number()
    .int()
    .min(MIN_RESULTS, `limit must be >= ${MIN_RESULTS}`)
    .max(MAX_RESULTS, `limit must be <= ${MAX_RESULTS}`)
    .default(10),
  cursor: z.string().trim().optional(),

  // Filters
  categories: z
    .array(z.string().trim().min(1, "category cannot be empty").max(100, "category too long"))
    .max(MAX_CATEGORIES, `maximum ${MAX_CATEGORIES} categories allowed`)
    .optional(),

  priceRange: PriceRangeSchema.optional(),

  ratingRange: RatingRangeSchema.optional(),

  timeWindow: TimeWindowSchema.optional(),

  geo: GeoFilterSchema.optional(),

  // Sorting/ranking — also supports 'distance' when geo is provided
  sortBy: z.enum(["rating", "price", "relevance", "distance"]).default("relevance"),

  // Hold suppression
  suppressHeld: z.boolean().default(true),
  showHeldReleaseEta: z.boolean().default(false),

  // Facet counts
  includeFacets: z.boolean().default(false),

  // Result diversification
  diversify: z.boolean().default(true),
  supplierCap: z
    .number()
    .int()
    .min(MIN_SUPPLIER_CAP, `supplierCap must be >= ${MIN_SUPPLIER_CAP}`)
    .max(MAX_SUPPLIER_CAP, `supplierCap must be <= ${MAX_SUPPLIER_CAP}`)
    .optional(),
}).superRefine((data, ctx) => {
  if (data.sortBy === "distance" && !data.geo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sortBy 'distance' requires a geo filter",
      path: ["sortBy"],
    });
  }
  if (data.geo && data.cursor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "cursor-based pagination is not supported with a geo filter; use page-based pagination",
      path: ["cursor"],
    });
  }
});

export type MarketplaceSearchQueryInput = z.input<typeof MarketplaceSearchSchema>;
export type MarketplaceSearchQuery = z.output<typeof MarketplaceSearchSchema>;

/**
 * Validate and parse marketplace search query parameters.
 * Returns parsed query or throws ZodError with details.
 *
 * @param query Raw query parameters
 * @returns Validated and parsed query object
 * @throws ZodError if validation fails
 */
export function validateSearchQuery(query: unknown): MarketplaceSearchQuery {
  return MarketplaceSearchSchema.parse(query);
}

/**
 * Check if search query would return pathological results
 * (e.g., empty filter combinations that are contradictory)
 *
 * @param query Validated search query
 * @returns null if valid, error message if pathological
 */
export function detectPathologicalQuery(query: MarketplaceSearchQuery): string | null {
  // Check for impossible price range
  if (query.priceRange?.min !== undefined && query.priceRange?.max !== undefined) {
    if (query.priceRange.max < query.priceRange.min) {
      return "Price range max is less than min (contradictory filter)";
    }
  }

  // Check for impossible rating range
  if (query.ratingRange?.min !== undefined && query.ratingRange?.max !== undefined) {
    if (query.ratingRange.max < query.ratingRange.min) {
      return "Rating range max is less than min (contradictory filter)";
    }
  }

  // Check for impossible time window
  if (query.timeWindow?.startTime !== undefined && query.timeWindow?.endTime !== undefined) {
    if (query.timeWindow.endTime <= query.timeWindow.startTime) {
      return "Time window end must be after start";
    }
  }

  return null;
}
