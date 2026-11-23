/**
 * H3 Geo Index Helper Tests
 *
 * Covers:
 * - Basic cell/candidate/distance correctness
 * - Antimeridian wrap (±180° longitude)
 * - Polar corner cases
 * - Ring size scaling with radius
 */

import { describe, it, expect } from "@jest/globals";
import {
  GEO_INDEX_RESOLUTION,
  MAX_RADIUS_KM,
  computeH3Cell,
  computeRingSize,
  computeCandidateCells,
  distanceKm,
} from "../h3GeoIndex.js";

describe("h3GeoIndex", () => {
  describe("computeH3Cell", () => {
    it("returns a valid H3 cell string for an ordinary coordinate", () => {
      const cell = computeH3Cell(37.7749, -122.4194); // San Francisco
      expect(typeof cell).toBe("string");
      expect(cell.length).toBeGreaterThan(0);
    });

    it("is deterministic for the same input", () => {
      const a = computeH3Cell(51.5074, -0.1278);
      const b = computeH3Cell(51.5074, -0.1278);
      expect(a).toBe(b);
    });

    it("produces different cells for distinct, well-separated coordinates", () => {
      const a = computeH3Cell(0, 0);
      const b = computeH3Cell(45, 90);
      expect(a).not.toBe(b);
    });
  });

  describe("computeRingSize", () => {
    it("returns at least 1 for a very small radius", () => {
      expect(computeRingSize(0.001)).toBeGreaterThanOrEqual(1);
    });

    it("grows monotonically with radius", () => {
      const small = computeRingSize(1);
      const medium = computeRingSize(10);
      const large = computeRingSize(MAX_RADIUS_KM);
      expect(medium).toBeGreaterThanOrEqual(small);
      expect(large).toBeGreaterThanOrEqual(medium);
    });
  });

  describe("computeCandidateCells", () => {
    it("always includes the center cell of the query point", () => {
      const lat = 40.7128;
      const lng = -74.006;
      const centerCell = computeH3Cell(lat, lng);
      const candidates = computeCandidateCells(lat, lng, 5);
      expect(candidates).toContain(centerCell);
    });

    it("returns a non-empty set for a typical radius (no empty tile for a valid point)", () => {
      const candidates = computeCandidateCells(6.5244, 3.3792, 10); // Lagos
      expect(candidates.length).toBeGreaterThan(0);
    });

    it("returns more candidate cells for a larger radius than a smaller one", () => {
      const small = computeCandidateCells(52.52, 13.405, 1); // Berlin
      const large = computeCandidateCells(52.52, 13.405, 50);
      expect(large.length).toBeGreaterThan(small.length);
    });

    it("handles points exactly at the antimeridian (lng = 180 / -180)", () => {
      // Should not throw, and should produce a sane candidate set.
      const at180 = computeCandidateCells(0, 180, 10);
      const atNeg180 = computeCandidateCells(0, -180, 10);
      expect(at180.length).toBeGreaterThan(0);
      expect(atNeg180.length).toBeGreaterThan(0);
      // 180 and -180 refer to the same meridian; cells should match.
      expect(new Set(at180)).toEqual(new Set(atNeg180));
    });

    it("finds a nearby point across the antimeridian within the candidate/distance pipeline", () => {
      // Two points ~20km apart straddling the dateline.
      const queryLat = 0;
      const queryLng = 179.9;
      const targetLat = 0;
      const targetLng = -179.9; // ~22km east of 179.9 across the dateline

      const candidates = computeCandidateCells(queryLat, queryLng, 30);
      const targetCell = computeH3Cell(targetLat, targetLng);

      // The target's cell must appear in the candidate tile set — this is
      // the case a flat lng-range bounding box would incorrectly miss.
      expect(candidates).toContain(targetCell);

      const d = distanceKm(queryLat, queryLng, targetLat, targetLng);
      expect(d).toBeLessThan(30);
      expect(d).toBeGreaterThan(0);
    });

    it("handles points very close to the North Pole", () => {
      const candidates = computeCandidateCells(89.9, 45, 20);
      expect(candidates.length).toBeGreaterThan(0);
      // Every returned cell must be a validly formed H3 index string.
      for (const cell of candidates) {
        expect(typeof cell).toBe("string");
        expect(cell.length).toBeGreaterThan(0);
      }
    });

    it("handles points very close to the South Pole", () => {
      const candidates = computeCandidateCells(-89.9, -120, 20);
      expect(candidates.length).toBeGreaterThan(0);
    });

    it("computes correct short distances near the pole despite large longitude deltas", () => {
      // Near the pole, small physical distances can span huge longitude deltas.
      const d = distanceKm(89.9, 0, 89.9, 180);
      // These two points are close together physically (both near the pole)
      // even though their longitudes differ by the maximum possible amount.
      expect(d).toBeLessThan(30);
    });
  });

  describe("distanceKm", () => {
    it("returns ~0 for identical coordinates", () => {
      expect(distanceKm(10, 20, 10, 20)).toBeCloseTo(0, 5);
    });

    it("computes a known approximate distance (London to Paris, ~344km)", () => {
      const d = distanceKm(51.5074, -0.1278, 48.8566, 2.3522);
      expect(d).toBeGreaterThan(300);
      expect(d).toBeLessThan(400);
    });

    it("is symmetric", () => {
      const a = distanceKm(10, 10, 20, 20);
      const b = distanceKm(20, 20, 10, 10);
      expect(a).toBeCloseTo(b, 6);
    });
  });

  describe("GEO_INDEX_RESOLUTION", () => {
    it("is a fixed, valid H3 resolution", () => {
      expect(GEO_INDEX_RESOLUTION).toBeGreaterThanOrEqual(0);
      expect(GEO_INDEX_RESOLUTION).toBeLessThanOrEqual(15);
    });
  });
});
