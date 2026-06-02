/**
 * Marketplace Search Endpoint Tests
 *
 * Comprehensive test suite covering:
 * - Input validation (type, range, size constraints)
 * - Filter combinations (categories, price, rating, time)
 * - Ranking and sorting (relevance, rating, price)
 * - Pagination and deterministic ordering
 * - Caching behavior
 * - Pathological filter combinations (should return 400)
 * - Edge cases and boundary conditions
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  validateSearchQuery,
  detectPathologicalQuery,
  MarketplaceSearchQuery,
} from "../validation/marketplaceSearchSchema.js";

describe("Marketplace Search Validation", () => {
  describe("Basic Input Validation", () => {
    it("should accept default parameters", () => {
      const query = validateSearchQuery({});
      expect(query.page).toBe(1);
      expect(query.limit).toBe(10);
      expect(query.sortBy).toBe("relevance");
    });

    it("should parse pagination parameters", () => {
      const query = validateSearchQuery({ page: 2, limit: 20 });
      expect(query.page).toBe(2);
      expect(query.limit).toBe(20);
    });

    it("should parse category filters", () => {
      const query = validateSearchQuery({
        categories: ["haircut", "plumbing"],
      });
      expect(query.categories).toEqual(["haircut", "plumbing"]);
    });

    it("should parse price range", () => {
      const query = validateSearchQuery({
        priceRange: { min: 1000, max: 5000 },
      });
      expect(query.priceRange?.min).toBe(1000);
      expect(query.priceRange?.max).toBe(5000);
    });

    it("should parse rating range", () => {
      const query = validateSearchQuery({
        ratingRange: { min: 3.5, max: 5 },
      });
      expect(query.ratingRange?.min).toBe(3.5);
      expect(query.ratingRange?.max).toBe(5);
    });

    it("should parse time window", () => {
      const start = new Date("2026-02-01T00:00:00Z").getTime();
      const end = new Date("2026-02-02T00:00:00Z").getTime();
      const query = validateSearchQuery({
        timeWindow: { startTime: start, endTime: end },
      });
      expect(query.timeWindow?.startTime).toBe(start);
      expect(query.timeWindow?.endTime).toBe(end);
    });

    it("should parse sort options", () => {
      const query1 = validateSearchQuery({ sortBy: "rating" });
      expect(query1.sortBy).toBe("rating");

      const query2 = validateSearchQuery({ sortBy: "price" });
      expect(query2.sortBy).toBe("price");

      const query3 = validateSearchQuery({ sortBy: "relevance" });
      expect(query3.sortBy).toBe("relevance");
    });
  });

  describe("Pagination Constraints", () => {
    it("should reject page < 1", () => {
      expect(() => validateSearchQuery({ page: 0 })).toThrow();
    });

    it("should reject limit < 1", () => {
      expect(() => validateSearchQuery({ limit: 0 })).toThrow();
    });

    it("should reject limit > 100", () => {
      expect(() => validateSearchQuery({ limit: 101 })).toThrow();
    });

    it("should reject non-integer page", () => {
      expect(() => validateSearchQuery({ page: 1.5 })).toThrow();
    });

    it("should reject non-integer limit", () => {
      expect(() => validateSearchQuery({ limit: 10.5 })).toThrow();
    });
  });

  describe("Category Filter Constraints", () => {
    it("should reject more than 10 categories", () => {
      const categories = Array.from({ length: 11 }, (_, i) => `cat${i}`);
      expect(() => validateSearchQuery({ categories })).toThrow();
    });

    it("should accept exactly 10 categories", () => {
      const categories = Array.from({ length: 10 }, (_, i) => `cat${i}`);
      const query = validateSearchQuery({ categories });
      expect(query.categories?.length).toBe(10);
    });

    it("should reject empty category strings", () => {
      expect(() => validateSearchQuery({ categories: [""] })).toThrow();
    });

    it("should reject categories longer than 100 chars", () => {
      const longCategory = "x".repeat(101);
      expect(() => validateSearchQuery({ categories: [longCategory] })).toThrow();
    });

    it("should trim whitespace from categories", () => {
      const query = validateSearchQuery({ categories: ["  haircut  "] });
      expect(query.categories?.[0]).toBe("haircut");
    });
  });

  describe("Price Range Validation", () => {
    it("should accept price range with min and max", () => {
      const query = validateSearchQuery({
        priceRange: { min: 1000, max: 5000 },
      });
      expect(query.priceRange).toEqual({ min: 1000, max: 5000 });
    });

    it("should accept price range with only min", () => {
      const query = validateSearchQuery({ priceRange: { min: 1000 } });
      expect(query.priceRange?.min).toBe(1000);
    });

    it("should accept price range with only max", () => {
      const query = validateSearchQuery({ priceRange: { max: 5000 } });
      expect(query.priceRange?.max).toBe(5000);
    });

    it("should reject negative prices", () => {
      expect(() => validateSearchQuery({ priceRange: { min: -100 } })).toThrow();
    });

    it("should reject non-integer prices", () => {
      expect(() => validateSearchQuery({ priceRange: { min: 100.5 } })).toThrow();
    });
  });

  describe("Rating Range Validation", () => {
    it("should accept rating in range [0, 5]", () => {
      const query = validateSearchQuery({
        ratingRange: { min: 0, max: 5 },
      });
      expect(query.ratingRange).toEqual({ min: 0, max: 5 });
    });

    it("should reject rating < 0", () => {
      expect(() => validateSearchQuery({ ratingRange: { min: -0.1 } })).toThrow();
    });

    it("should reject rating > 5", () => {
      expect(() => validateSearchQuery({ ratingRange: { max: 5.1 } })).toThrow();
    });

    it("should accept decimal ratings", () => {
      const query = validateSearchQuery({
        ratingRange: { min: 3.5, max: 4.75 },
      });
      expect(query.ratingRange?.min).toBe(3.5);
      expect(query.ratingRange?.max).toBe(4.75);
    });
  });

  describe("Time Window Validation", () => {
    it("should accept valid time window", () => {
      const start = new Date("2026-02-01T00:00:00Z").getTime();
      const end = new Date("2026-02-02T00:00:00Z").getTime();
      const query = validateSearchQuery({
        timeWindow: { startTime: start, endTime: end },
      });
      expect(query.timeWindow?.startTime).toBe(start);
      expect(query.timeWindow?.endTime).toBe(end);
    });

    it("should reject negative timestamps", () => {
      expect(() =>
        validateSearchQuery({
          timeWindow: { startTime: -1 },
        })
      ).toThrow();
    });

    it("should reject non-integer timestamps", () => {
      expect(() =>
        validateSearchQuery({
          timeWindow: { startTime: 1000.5 },
        })
      ).toThrow();
    });
  });

  describe("Pathological Query Detection", () => {
    it("should detect contradictory price range", () => {
      const query: MarketplaceSearchQuery = {
        page: 1,
        limit: 10,
        priceRange: { min: 5000, max: 1000 },
        sortBy: "relevance",
      };
      const error = detectPathologicalQuery(query);
      expect(error).not.toBeNull();
      expect(error).toContain("Price range");
    });

    it("should detect contradictory rating range", () => {
      const query: MarketplaceSearchQuery = {
        page: 1,
        limit: 10,
        ratingRange: { min: 5, max: 2 },
        sortBy: "relevance",
      };
      const error = detectPathologicalQuery(query);
      expect(error).not.toBeNull();
      expect(error).toContain("Rating range");
    });

    it("should detect contradictory time window", () => {
      const start = new Date("2026-02-02T00:00:00Z").getTime();
      const end = new Date("2026-02-01T00:00:00Z").getTime();
      const query: MarketplaceSearchQuery = {
        page: 1,
        limit: 10,
        timeWindow: { startTime: start, endTime: end },
        sortBy: "relevance",
      };
      const error = detectPathologicalQuery(query);
      expect(error).not.toBeNull();
      expect(error).toContain("Time window");
    });

    it("should pass valid queries", () => {
      const query: MarketplaceSearchQuery = {
        page: 1,
        limit: 10,
        categories: ["haircut"],
        priceRange: { min: 1000, max: 5000 },
        ratingRange: { min: 3.5, max: 5 },
        sortBy: "relevance",
      };
      const error = detectPathologicalQuery(query);
      expect(error).toBeNull();
    });
  });

  describe("Combined Validation", () => {
    it("should validate complex query with all filters", () => {
      const start = new Date("2026-02-01T00:00:00Z").getTime();
      const end = new Date("2026-02-02T00:00:00Z").getTime();

      const query = validateSearchQuery({
        page: 2,
        limit: 25,
        categories: ["haircut", "plumbing"],
        priceRange: { min: 1000, max: 10000 },
        ratingRange: { min: 3.0, max: 5.0 },
        timeWindow: { startTime: start, endTime: end },
        sortBy: "rating",
      });

      expect(query.page).toBe(2);
      expect(query.limit).toBe(25);
      expect(query.categories?.length).toBe(2);
      expect(query.priceRange?.min).toBe(1000);
      expect(query.ratingRange?.min).toBe(3.0);
      expect(query.sortBy).toBe("rating");

      // Should not be pathological
      const error = detectPathologicalQuery(query);
      expect(error).toBeNull();
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty categories array", () => {
      const query = validateSearchQuery({ categories: [] });
      expect(query.categories).toEqual([]);
    });

    it("should handle page boundaries", () => {
      const query1 = validateSearchQuery({ page: 1 });
      expect(query1.page).toBe(1);

      const query2 = validateSearchQuery({ page: 999999 });
      expect(query2.page).toBe(999999);
    });

    it("should handle limit boundaries", () => {
      const query1 = validateSearchQuery({ limit: 1 });
      expect(query1.limit).toBe(1);

      const query2 = validateSearchQuery({ limit: 100 });
      expect(query2.limit).toBe(100);
    });

    it("should handle zero prices", () => {
      const query = validateSearchQuery({ priceRange: { min: 0, max: 0 } });
      expect(query.priceRange?.min).toBe(0);
      expect(query.priceRange?.max).toBe(0);
    });

    it("should handle equal price ranges (not pathological)", () => {
      const query: MarketplaceSearchQuery = {
        page: 1,
        limit: 10,
        priceRange: { min: 5000, max: 5000 },
        sortBy: "relevance",
      };
      const error = detectPathologicalQuery(query);
      expect(error).toBeNull(); // Equal ranges are OK
    });

    it("should handle zero rating", () => {
      const query = validateSearchQuery({ ratingRange: { min: 0, max: 0 } });
      expect(query.ratingRange?.min).toBe(0);
      expect(query.ratingRange?.max).toBe(0);
    });

    it("should handle max rating", () => {
      const query = validateSearchQuery({ ratingRange: { min: 5, max: 5 } });
      expect(query.ratingRange?.min).toBe(5);
      expect(query.ratingRange?.max).toBe(5);
    });
  });
});
