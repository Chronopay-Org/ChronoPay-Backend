/**
 * Marketplace Search Schema — Geo Filter Validation Tests
 */

import { describe, it, expect } from "@jest/globals";
import { validateSearchQuery } from "../marketplaceSearchSchema.js";
import { MAX_RADIUS_KM } from "../../services/geo/h3GeoIndex.js";

describe("Marketplace Search Schema — Geo Filter", () => {
  it("accepts a valid geo filter", () => {
    const query = validateSearchQuery({ geo: { lat: 37.7749, lng: -122.4194, radiusKm: 10 } });
    expect(query.geo).toEqual({ lat: 37.7749, lng: -122.4194, radiusKm: 10 });
  });

  it("accepts sortBy distance when geo is present", () => {
    const query = validateSearchQuery({
      geo: { lat: 0, lng: 0, radiusKm: 5 },
      sortBy: "distance",
    });
    expect(query.sortBy).toBe("distance");
  });

  it("rejects sortBy distance when geo is absent", () => {
    expect(() => validateSearchQuery({ sortBy: "distance" })).toThrow();
  });

  it("rejects lat below -90", () => {
    expect(() => validateSearchQuery({ geo: { lat: -90.1, lng: 0, radiusKm: 5 } })).toThrow();
  });

  it("rejects lat above 90", () => {
    expect(() => validateSearchQuery({ geo: { lat: 90.1, lng: 0, radiusKm: 5 } })).toThrow();
  });

  it("accepts lat at exactly the boundary values", () => {
    expect(() => validateSearchQuery({ geo: { lat: 90, lng: 180, radiusKm: 5 } })).not.toThrow();
    expect(() => validateSearchQuery({ geo: { lat: -90, lng: -180, radiusKm: 5 } })).not.toThrow();
  });

  it("rejects lng below -180", () => {
    expect(() => validateSearchQuery({ geo: { lat: 0, lng: -180.1, radiusKm: 5 } })).toThrow();
  });

  it("rejects lng above 180", () => {
    expect(() => validateSearchQuery({ geo: { lat: 0, lng: 180.1, radiusKm: 5 } })).toThrow();
  });

  it("rejects a zero radius", () => {
    expect(() => validateSearchQuery({ geo: { lat: 0, lng: 0, radiusKm: 0 } })).toThrow();
  });

  it("rejects a negative radius", () => {
    expect(() => validateSearchQuery({ geo: { lat: 0, lng: 0, radiusKm: -5 } })).toThrow();
  });

  it("rejects a radius above MAX_RADIUS_KM", () => {
    expect(() =>
      validateSearchQuery({ geo: { lat: 0, lng: 0, radiusKm: MAX_RADIUS_KM + 1 } })
    ).toThrow();
  });

  it("accepts a radius exactly at MAX_RADIUS_KM", () => {
    expect(() =>
      validateSearchQuery({ geo: { lat: 0, lng: 0, radiusKm: MAX_RADIUS_KM } })
    ).not.toThrow();
  });

  it("rejects combining a geo filter with a cursor", () => {
    expect(() =>
      validateSearchQuery({
        geo: { lat: 0, lng: 0, radiusKm: 5 },
        cursor: "eyJzb3J0QnkiOiJyZWxldmFuY2UiLCJpZCI6MTB9",
      })
    ).toThrow();
  });

  it("allows a cursor when no geo filter is present", () => {
    expect(() =>
      validateSearchQuery({ cursor: "eyJzb3J0QnkiOiJyZWxldmFuY2UiLCJpZCI6MTB9" })
    ).not.toThrow();
  });

  it("allows geo combined with non-distance sortBy", () => {
    const query = validateSearchQuery({
      geo: { lat: 0, lng: 0, radiusKm: 5 },
      sortBy: "price",
    });
    expect(query.sortBy).toBe("price");
    expect(query.geo).toBeDefined();
  });

  it("omits geo entirely when not provided", () => {
    const query = validateSearchQuery({});
    expect(query.geo).toBeUndefined();
  });
});
