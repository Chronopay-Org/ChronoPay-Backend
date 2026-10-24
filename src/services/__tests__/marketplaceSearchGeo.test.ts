/**
 * Marketplace Search — Geo-Radius Tests
 *
 * Covers the H3-indexed radius filter + precise distance sort end-to-end
 * through MarketplaceSearchService, using an in-memory mock pg Pool.
 *
 * - Radius correctness (H3 prefilter tile vs. exact great-circle cutoff)
 * - Distance sort ordering
 * - Antimeridian wrap and polar corner cases
 * - Empty tile (no slots in the searched area)
 * - Interaction with other filters (category/price/rating) and with
 *   non-distance sortBy options
 * - Pagination
 * - Candidate-set cap (MAX_GEO_CANDIDATES) is applied as a query LIMIT
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { MarketplaceSearchService, MarketplaceSearchError } from "../marketplaceSearchService.js";
import { MarketplaceSearchQuery, validateSearchQuery } from "../../validation/marketplaceSearchSchema.js";
import { computeH3Cell, MAX_GEO_CANDIDATES } from "../geo/h3GeoIndex.js";

interface DbSlotRow {
  id: number;
  professional_id: string;
  start_time: Date;
  end_time: Date;
  category: string;
  price_cents: number;
  supplier_rating: number;
  status: string;
  created_at: Date;
  latitude: number;
  longitude: number;
  h3_cell_res7: string;
}

/**
 * Minimal mock pg Pool covering exactly the SQL shapes emitted by the
 * geo-radius code path in MarketplaceSearchService (status filter, optional
 * category/price/rating filters, the H3 `= ANY($n::text[])` prefilter, and
 * a trailing `LIMIT $n` with no OFFSET/ORDER BY — sorting and the exact
 * radius cutoff happen in application code).
 */
class MockGeoPgPool {
  public slots: DbSlotRow[] = [];
  public lastQuery: { sql: string; params: any[] } | null = null;

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    this.lastQuery = { sql, params };

    let result = this.slots.filter((slot) => {
      const statusMatch = sql.match(/status = \$(\d+)/);
      if (statusMatch) {
        const val = params[parseInt(statusMatch[1], 10) - 1];
        if (slot.status !== val) return false;
      }

      const catMatch = sql.match(/category IN \(([^)]+)\)/);
      if (catMatch) {
        const idxs = catMatch[1].match(/\$(\d+)/g)?.map((p) => parseInt(p.replace("$", ""), 10) - 1);
        if (idxs) {
          const categories = idxs.map((i) => params[i]);
          if (!categories.includes(slot.category)) return false;
        }
      }

      const minPriceMatch = sql.match(/price_cents >= \$(\d+)/);
      if (minPriceMatch) {
        const val = params[parseInt(minPriceMatch[1], 10) - 1];
        if (slot.price_cents < val) return false;
      }
      const maxPriceMatch = sql.match(/price_cents <= \$(\d+)/);
      if (maxPriceMatch) {
        const val = params[parseInt(maxPriceMatch[1], 10) - 1];
        if (slot.price_cents > val) return false;
      }

      const minRatingMatch = sql.match(/supplier_rating >= \$(\d+)/);
      if (minRatingMatch) {
        const val = params[parseInt(minRatingMatch[1], 10) - 1];
        if (slot.supplier_rating < val) return false;
      }

      const geoMatch = sql.match(/h3_cell_res7 = ANY\(\$(\d+)::text\[\]\)/);
      if (geoMatch) {
        const idx = parseInt(geoMatch[1], 10) - 1;
        const cells: string[] = params[idx];
        if (!cells.includes(slot.h3_cell_res7)) return false;
      }

      return true;
    });

    const limitMatch = sql.match(/LIMIT \$(\d+)/);
    if (limitMatch) {
      const idx = parseInt(limitMatch[1], 10) - 1;
      const limit = params[idx];
      result = result.slice(0, limit);
    }

    return {
      rows: result.map((s) => ({
        id: s.id,
        professional: s.professional_id,
        startTime: s.start_time,
        endTime: s.end_time,
        category: s.category,
        price_cents: s.price_cents,
        supplier_rating: s.supplier_rating,
        status: s.status,
        created_at: s.created_at,
        latitude: s.latitude,
        longitude: s.longitude,
      })),
    };
  }
}

function makeSlot(overrides: Partial<DbSlotRow> & { lat: number; lng: number }): DbSlotRow {
  const { lat, lng, ...rest } = overrides;
  return {
    id: 1,
    professional_id: "prof-1",
    start_time: new Date("2026-02-01T10:00:00Z"),
    end_time: new Date("2026-02-01T11:00:00Z"),
    category: "haircut",
    price_cents: 2000,
    supplier_rating: 4.0,
    status: "available",
    created_at: new Date("2026-01-01T00:00:00Z"),
    latitude: lat,
    longitude: lng,
    h3_cell_res7: computeH3Cell(lat, lng),
    ...rest,
  };
}

function buildQuery(overrides: Partial<MarketplaceSearchQuery> = {}): MarketplaceSearchQuery {
  return validateSearchQuery(overrides as unknown);
}

describe("Marketplace Search — Geo Radius", () => {
  let pool: MockGeoPgPool;
  let service: MarketplaceSearchService;

  beforeEach(() => {
    pool = new MockGeoPgPool();
    service = new MarketplaceSearchService(pool as any);
  });

  describe("basic radius correctness", () => {
    it("returns only slots within the requested radius", async () => {
      // Center: San Francisco. One slot ~1km away, one ~50km away.
      const centerLat = 37.7749;
      const centerLng = -122.4194;

      pool.slots = [
        makeSlot({ id: 1, lat: 37.784, lng: -122.4194 }), // ~1km north
        makeSlot({ id: 2, lat: 38.2, lng: -122.4194 }), // ~47km north
      ];

      const query = buildQuery({ geo: { lat: centerLat, lng: centerLng, radiusKm: 10 }, sortBy: "distance" });
      const result = await service.search(query);

      expect(result.total).toBe(1);
      expect(result.slots.map((s) => s.id)).toEqual([1]);
      expect(result.slots[0].distanceKm).toBeLessThan(10);
    });

    it("excludes slots that fall within the H3 prefilter tile but outside the exact radius", async () => {
      // Two slots in the same/adjacent H3 cells as the query point, but at
      // different distances — the prefilter alone would not distinguish them.
      const centerLat = 40.7128;
      const centerLng = -74.006;

      pool.slots = [
        makeSlot({ id: 1, lat: 40.715, lng: -74.006 }), // very close
        makeSlot({ id: 2, lat: 40.9, lng: -74.006 }), // ~21km away
      ];

      const query = buildQuery({ geo: { lat: centerLat, lng: centerLng, radiusKm: 5 } });
      const result = await service.search(query);

      expect(result.total).toBe(1);
      expect(result.slots[0].id).toBe(1);
    });

    it("returns an empty result set for an area with no slots (empty tile)", async () => {
      pool.slots = [makeSlot({ id: 1, lat: 10, lng: 10 })];

      const query = buildQuery({ geo: { lat: -33.8688, lng: 151.2093, radiusKm: 20 } }); // Sydney; no slots nearby
      const result = await service.search(query);

      expect(result.total).toBe(0);
      expect(result.slots).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe("antimeridian and polar cases", () => {
    it("finds a slot across the antimeridian from the query point", async () => {
      pool.slots = [makeSlot({ id: 1, lat: 0, lng: -179.9 })];

      const query = buildQuery({ geo: { lat: 0, lng: 179.9, radiusKm: 30 }, sortBy: "distance" });
      const result = await service.search(query);

      expect(result.total).toBe(1);
      expect(result.slots[0].id).toBe(1);
      expect(result.slots[0].distanceKm).toBeLessThan(30);
    });

    it("does not return an antimeridian slot when it's outside the requested radius", async () => {
      pool.slots = [makeSlot({ id: 1, lat: 0, lng: -179.9 })];

      const query = buildQuery({ geo: { lat: 0, lng: 179.9, radiusKm: 1 } });
      const result = await service.search(query);

      expect(result.total).toBe(0);
    });

    it("finds a slot near the North Pole within radius", async () => {
      pool.slots = [makeSlot({ id: 1, lat: 89.95, lng: 10 })];

      const query = buildQuery({ geo: { lat: 89.9, lng: 100, radiusKm: 30 }, sortBy: "distance" });
      const result = await service.search(query);

      expect(result.total).toBe(1);
      expect(result.slots[0].id).toBe(1);
    });
  });

  describe("sort behavior", () => {
    beforeEach(() => {
      const centerLat = 51.5074;
      const centerLng = -0.1278;
      pool.slots = [
        makeSlot({ id: 1, lat: 51.51, lng: -0.1278, price_cents: 3000, supplier_rating: 4.9 }), // closest
        makeSlot({ id: 2, lat: 51.52, lng: -0.1278, price_cents: 1000, supplier_rating: 3.0 }), // mid distance, cheapest
        makeSlot({ id: 3, lat: 51.53, lng: -0.1278, price_cents: 5000, supplier_rating: 5.0 }), // farthest, best rated
      ];
      void centerLat;
      void centerLng;
    });

    it("sorts by distance ascending when sortBy is distance", async () => {
      const query = buildQuery({
        geo: { lat: 51.5074, lng: -0.1278, radiusKm: 50 },
        sortBy: "distance",
      });
      const result = await service.search(query);
      expect(result.slots.map((s) => s.id)).toEqual([1, 2, 3]);
      // Distances should be non-decreasing
      const distances = result.slots.map((s) => s.distanceKm!);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
    });

    it("sorts by price ascending when sortBy is price, independent of distance", async () => {
      const query = buildQuery({
        geo: { lat: 51.5074, lng: -0.1278, radiusKm: 50 },
        sortBy: "price",
      });
      const result = await service.search(query);
      expect(result.slots.map((s) => s.id)).toEqual([2, 1, 3]);
    });

    it("sorts by rating descending when sortBy is rating", async () => {
      const query = buildQuery({
        geo: { lat: 51.5074, lng: -0.1278, radiusKm: 50 },
        sortBy: "rating",
      });
      const result = await service.search(query);
      expect(result.slots.map((s) => s.id)).toEqual([3, 1, 2]);
    });

    it("every geo result includes a rounded distanceKm field", async () => {
      const query = buildQuery({
        geo: { lat: 51.5074, lng: -0.1278, radiusKm: 50 },
        sortBy: "distance",
      });
      const result = await service.search(query);
      for (const slot of result.slots) {
        expect(typeof slot.distanceKm).toBe("number");
        expect(slot.distanceKm).toBe(Math.round(slot.distanceKm! * 100) / 100);
      }
    });

    it("sorts by relevance (rating desc, then price asc) by default within the radius", async () => {
      const query = buildQuery({
        geo: { lat: 51.5074, lng: -0.1278, radiusKm: 50 },
        // sortBy omitted -> defaults to "relevance"
      });
      const result = await service.search(query);
      // slot 3: rating 5.0 (highest) -> first
      // slot 1: rating 4.9 -> second
      // slot 2: rating 3.0 -> third
      expect(result.slots.map((s) => s.id)).toEqual([3, 1, 2]);
    });

    it("breaks ties on id when distances are equal", async () => {
      pool.slots = [
        makeSlot({ id: 5, lat: 51.51, lng: -0.1278 }),
        makeSlot({ id: 4, lat: 51.51, lng: -0.1278 }), // identical coordinates -> identical distance
      ];
      const query = buildQuery({ geo: { lat: 51.5074, lng: -0.1278, radiusKm: 50 }, sortBy: "distance" });
      const result = await service.search(query);
      expect(result.slots.map((s) => s.id)).toEqual([4, 5]);
    });

    it("breaks ties on id when prices are equal", async () => {
      pool.slots = [
        makeSlot({ id: 5, lat: 51.51, lng: -0.1278, price_cents: 1500 }),
        makeSlot({ id: 4, lat: 51.52, lng: -0.1278, price_cents: 1500 }),
      ];
      const query = buildQuery({ geo: { lat: 51.5074, lng: -0.1278, radiusKm: 50 }, sortBy: "price" });
      const result = await service.search(query);
      expect(result.slots.map((s) => s.id)).toEqual([4, 5]);
    });

    it("breaks ties on id when ratings are equal", async () => {
      pool.slots = [
        makeSlot({ id: 5, lat: 51.51, lng: -0.1278, supplier_rating: 4.5 }),
        makeSlot({ id: 4, lat: 51.52, lng: -0.1278, supplier_rating: 4.5 }),
      ];
      const query = buildQuery({ geo: { lat: 51.5074, lng: -0.1278, radiusKm: 50 }, sortBy: "rating" });
      const result = await service.search(query);
      expect(result.slots.map((s) => s.id)).toEqual([4, 5]);
    });

    it("breaks ties on id under relevance sort when rating and price are both equal", async () => {
      pool.slots = [
        makeSlot({ id: 5, lat: 51.51, lng: -0.1278, supplier_rating: 4.5, price_cents: 2000 }),
        makeSlot({ id: 4, lat: 51.52, lng: -0.1278, supplier_rating: 4.5, price_cents: 2000 }),
      ];
      const query = buildQuery({ geo: { lat: 51.5074, lng: -0.1278, radiusKm: 50 }, sortBy: "relevance" });
      const result = await service.search(query);
      expect(result.slots.map((s) => s.id)).toEqual([4, 5]);
    });
  });

  describe("combined with other filters", () => {
    it("applies category filter together with the geo radius", async () => {
      const centerLat = 48.8566;
      const centerLng = 2.3522;
      pool.slots = [
        makeSlot({ id: 1, lat: 48.86, lng: 2.3522, category: "haircut" }),
        makeSlot({ id: 2, lat: 48.86, lng: 2.3522, category: "plumbing" }),
      ];

      const query = buildQuery({
        geo: { lat: centerLat, lng: centerLng, radiusKm: 20 },
        categories: ["plumbing"],
      });
      const result = await service.search(query);

      expect(result.total).toBe(1);
      expect(result.slots[0].id).toBe(2);
    });

    it("applies price range filter together with the geo radius", async () => {
      const centerLat = 35.6762;
      const centerLng = 139.6503;
      pool.slots = [
        makeSlot({ id: 1, lat: 35.68, lng: 139.6503, price_cents: 500 }),
        makeSlot({ id: 2, lat: 35.68, lng: 139.6503, price_cents: 5000 }),
      ];

      const query = buildQuery({
        geo: { lat: centerLat, lng: centerLng, radiusKm: 20 },
        priceRange: { min: 1000 },
      });
      const result = await service.search(query);

      expect(result.total).toBe(1);
      expect(result.slots[0].id).toBe(2);
    });
  });

  describe("pagination", () => {
    it("paginates geo results using page/limit", async () => {
      const centerLat = 1.3521;
      const centerLng = 103.8198;
      pool.slots = Array.from({ length: 5 }, (_, i) =>
        makeSlot({ id: i + 1, lat: centerLat + i * 0.01, lng: centerLng })
      );

      const query = buildQuery({
        geo: { lat: centerLat, lng: centerLng, radiusKm: 20 },
        sortBy: "distance",
        page: 2,
        limit: 2,
      });
      const result = await service.search(query);

      expect(result.total).toBe(5);
      expect(result.slots.map((s) => s.id)).toEqual([3, 4]);
    });
  });

  describe("candidate cap", () => {
    it("applies MAX_GEO_CANDIDATES as the SQL LIMIT for the prefilter fetch", async () => {
      pool.slots = [makeSlot({ id: 1, lat: 1, lng: 1 })];

      const query = buildQuery({ geo: { lat: 1, lng: 1, radiusKm: 5 } });
      await service.search(query);

      expect(pool.lastQuery?.sql).toMatch(/LIMIT \$\d+/);
      expect(pool.lastQuery?.params).toContain(MAX_GEO_CANDIDATES);
    });
  });

  describe("caching", () => {
    it("caches geo search results and serves cache hits with cacheSource=hit", async () => {
      pool.slots = [makeSlot({ id: 1, lat: 1, lng: 1 })];
      const store = new Map<string, any>();
      const cache = {
        get: async (key: string) => store.get(key) ?? null,
        set: async (key: string, value: any) => {
          store.set(key, value);
        },
      };

      const query = buildQuery({ geo: { lat: 1, lng: 1, radiusKm: 5 } });
      const first = await service.search(query, cache);
      expect(first.cacheSource).toBe("miss");

      const second = await service.search(query, cache);
      expect(second.cacheSource).toBe("hit");
      expect(second.total).toBe(first.total);
    });

    it("does not fail the search when cache.set rejects", async () => {
      pool.slots = [makeSlot({ id: 1, lat: 1, lng: 1 })];
      const cache = {
        get: async () => null,
        set: async () => {
          throw new Error("cache backend unavailable");
        },
      };
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      const query = buildQuery({ geo: { lat: 1, lng: 1, radiusKm: 5 } });
      const result = await service.search(query, cache);

      expect(result.cacheSource).toBe("miss");
      expect(result.total).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to cache marketplace geo search result:",
        "cache backend unavailable"
      );
      warnSpy.mockRestore();
    });
  });

  describe("error handling", () => {
    it("propagates a database error thrown by the pool", async () => {
      const throwingPool = {
        query: async () => {
          throw new Error("connection terminated unexpectedly");
        },
      };
      const throwingService = new MarketplaceSearchService(throwingPool as any);
      const query = buildQuery({ geo: { lat: 1, lng: 1, radiusKm: 5 } });

      await expect(throwingService.search(query)).rejects.toThrow(
        "connection terminated unexpectedly"
      );
    });

    it("maps a database constraint error to a 400 MarketplaceSearchError", async () => {
      const throwingPool = {
        query: async () => {
          throw new Error("invalid input syntax for type numeric");
        },
      };
      const throwingService = new MarketplaceSearchService(throwingPool as any);
      const query = buildQuery({ geo: { lat: 1, lng: 1, radiusKm: 5 } });

      await expect(throwingService.search(query)).rejects.toMatchObject({
        name: "MarketplaceSearchError",
        statusCode: 400,
      });
    });

    it("passes a MarketplaceSearchError raised inside the query path straight through unmodified", async () => {
      const throwingPool = {
        query: async () => {
          throw new MarketplaceSearchError("downstream validation failed", 422, "detail");
        },
      };
      const throwingService = new MarketplaceSearchService(throwingPool as any);
      const query = buildQuery({ geo: { lat: 1, lng: 1, radiusKm: 5 } });

      await expect(throwingService.search(query)).rejects.toMatchObject({
        name: "MarketplaceSearchError",
        statusCode: 422,
        message: "downstream validation failed",
      });
    });
  });
});
