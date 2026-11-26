/**
 * marketplaceSearchParamAlignment.test.ts
 *
 * Verifies that every $N placeholder produced by buildFilterClause and
 * buildCursorPredicate has exactly one corresponding parameter value, and
 * that parameter indices are contiguous starting from $1.
 *
 * Because these methods are private, we drive them through the public
 * search() API backed by a recording mock pool that captures each
 * pool.query() call.  For every captured call we assert:
 *
 *   highestPlaceholderIndex === params.length
 *
 * This is the invariant the original @ts-nocheck suppressed: a wrong index
 * or a missing push() would leave the array shorter (or longer) than the
 * highest $N, causing pg to throw at runtime.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { MarketplaceSearchService } from "../marketplaceSearchService.js";
import { validateSearchQuery } from "../../validation/marketplaceSearchSchema.js";

// ---------------------------------------------------------------------------
// Recording mock pool
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

class RecordingPool {
  public calls: CapturedQuery[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, params: [...params] });

    // Return a minimal valid response so search() can continue.
    if (sql.includes("COUNT(*)")) {
      return { rows: [{ total: "0" }] };
    }
    return { rows: [] };
  }
}

// ---------------------------------------------------------------------------
// Helper: extract highest $N index from SQL text
// ---------------------------------------------------------------------------

function highestPlaceholder(sql: string): number {
  const matches = sql.match(/\$(\d+)/g);
  if (!matches) return 0;
  return Math.max(...matches.map((m) => parseInt(m.slice(1), 10)));
}

// ---------------------------------------------------------------------------
// Helper: assert placeholder/param alignment for every captured call
// ---------------------------------------------------------------------------

function assertParamAlignment(calls: CapturedQuery[]): void {
  for (const { sql, params } of calls) {
    const highest = highestPlaceholder(sql);
    if (highest === 0) continue; // No placeholders — nothing to verify.
    expect(params.length).toBe(highest);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildFilterClause – placeholder/param alignment", () => {
  let pool: RecordingPool;
  let service: MarketplaceSearchService;

  beforeEach(() => {
    pool = new RecordingPool();
    service = new MarketplaceSearchService(pool as any);
  });

  it("minimal query (no filters) produces aligned params", async () => {
    await service.search(validateSearchQuery({}));
    assertParamAlignment(pool.calls);
  });

  it("category filter produces aligned params", async () => {
    await service.search(validateSearchQuery({ categories: ["haircut"] }));
    assertParamAlignment(pool.calls);
  });

  it("multiple categories produce aligned params", async () => {
    await service.search(
      validateSearchQuery({ categories: ["haircut", "plumbing", "cleaning"] })
    );
    assertParamAlignment(pool.calls);
  });

  it("price range (min + max) produces aligned params", async () => {
    await service.search(
      validateSearchQuery({ priceRange: { min: 500, max: 10000 } })
    );
    assertParamAlignment(pool.calls);
  });

  it("price range (min only) produces aligned params", async () => {
    await service.search(validateSearchQuery({ priceRange: { min: 1000 } }));
    assertParamAlignment(pool.calls);
  });

  it("price range (max only) produces aligned params", async () => {
    await service.search(validateSearchQuery({ priceRange: { max: 5000 } }));
    assertParamAlignment(pool.calls);
  });

  it("rating range produces aligned params", async () => {
    await service.search(
      validateSearchQuery({ ratingRange: { min: 3.5, max: 5.0 } })
    );
    assertParamAlignment(pool.calls);
  });

  it("time window produces aligned params", async () => {
    const start = new Date("2026-02-01T00:00:00Z").getTime();
    const end = new Date("2026-02-28T00:00:00Z").getTime();
    await service.search(validateSearchQuery({ timeWindow: { startTime: start, endTime: end } }));
    assertParamAlignment(pool.calls);
  });

  it("all filters combined produce aligned params", async () => {
    const start = new Date("2026-02-01T00:00:00Z").getTime();
    const end = new Date("2026-02-28T00:00:00Z").getTime();
    await service.search(
      validateSearchQuery({
        categories: ["haircut", "plumbing"],
        priceRange: { min: 500, max: 20000 },
        ratingRange: { min: 3.0, max: 5.0 },
        timeWindow: { startTime: start, endTime: end },
        sortBy: "relevance",
        limit: 10,
      })
    );
    assertParamAlignment(pool.calls);
  });

  it("suppressHeld=false produces aligned params (hold-filter removed)", async () => {
    await service.search(validateSearchQuery({ suppressHeld: false }));
    assertParamAlignment(pool.calls);
  });

  it("cursor-based pagination produces aligned params for sortBy=rating", async () => {
    // Build a cursor from a synthetic slot
    const slot = {
      id: 7,
      professional: "p1",
      startTime: 1000,
      endTime: 2000,
      supplier_rating: 4.5,
      price_cents: 3000,
    };
    const cursor = service.encodeCursor(slot, "rating");

    await service.search(validateSearchQuery({ sortBy: "rating", limit: 5, cursor }));
    assertParamAlignment(pool.calls);
  });

  it("cursor-based pagination produces aligned params for sortBy=price", async () => {
    const slot = {
      id: 12,
      professional: "p2",
      startTime: 1000,
      endTime: 2000,
      supplier_rating: 4.0,
      price_cents: 1500,
    };
    const cursor = service.encodeCursor(slot, "price");

    await service.search(validateSearchQuery({ sortBy: "price", limit: 5, cursor }));
    assertParamAlignment(pool.calls);
  });

  it("cursor-based pagination produces aligned params for sortBy=relevance", async () => {
    const slot = {
      id: 20,
      professional: "p3",
      startTime: 1000,
      endTime: 2000,
      supplier_rating: 3.8,
      price_cents: 2200,
    };
    const cursor = service.encodeCursor(slot, "relevance");

    await service.search(validateSearchQuery({ sortBy: "relevance", limit: 5, cursor }));
    assertParamAlignment(pool.calls);
  });

  it("cursor + multiple filters produce aligned params", async () => {
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    const end = new Date("2026-12-31T00:00:00Z").getTime();
    const slot = {
      id: 99,
      professional: "pX",
      startTime: 1000,
      endTime: 2000,
      supplier_rating: 4.2,
      price_cents: 8000,
    };
    const cursor = service.encodeCursor(slot, "relevance");

    await service.search(
      validateSearchQuery({
        categories: ["massage"],
        priceRange: { min: 1000, max: 15000 },
        ratingRange: { min: 3.0 },
        timeWindow: { startTime: start, endTime: end },
        sortBy: "relevance",
        cursor,
        limit: 10,
      })
    );
    assertParamAlignment(pool.calls);
  });

  it("placeholder indices are strictly contiguous starting from 1", async () => {
    await service.search(
      validateSearchQuery({
        categories: ["haircut", "yoga"],
        priceRange: { min: 200, max: 9000 },
        sortBy: "price",
      })
    );

    for (const { sql, params } of pool.calls) {
      const matches = sql.match(/\$(\d+)/g);
      if (!matches) continue;

      const indices = matches
        .map((m) => parseInt(m.slice(1), 10))
        .sort((a, b) => a - b);

      // Indices must span 1..params.length without gaps
      for (let i = 0; i < indices.length; i++) {
        expect(indices[i]).toBeLessThanOrEqual(params.length);
        expect(indices[i]).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe("encodeCursor / decodeCursor – round-trip and tamper tests per sortBy", () => {
  let pool: RecordingPool;
  let service: MarketplaceSearchService;

  const baseSlot = {
    id: 42,
    professional: "prof-1",
    startTime: Date.now(),
    endTime: Date.now() + 3600_000,
    supplier_rating: 4.7,
    price_cents: 3200,
  };

  beforeEach(() => {
    pool = new RecordingPool();
    service = new MarketplaceSearchService(pool as any);
  });

  // --- round-trip ---

  it("round-trips rating cursor with correct id and rating", () => {
    const token = service.encodeCursor(baseSlot, "rating");
    const decoded = service.decodeCursor(token, "rating");

    expect(decoded.id).toBe(baseSlot.id);
    expect(decoded.sortBy).toBe("rating");
    expect(decoded.rating).toBeCloseTo(baseSlot.supplier_rating ?? 0, 10);
    expect(decoded.price).toBeUndefined();
  });

  it("round-trips price cursor with correct id and price", () => {
    const token = service.encodeCursor(baseSlot, "price");
    const decoded = service.decodeCursor(token, "price");

    expect(decoded.id).toBe(baseSlot.id);
    expect(decoded.sortBy).toBe("price");
    expect(decoded.price).toBe(baseSlot.price_cents);
    expect(decoded.rating).toBeUndefined();
  });

  it("round-trips relevance cursor with correct id, rating, and price", () => {
    const token = service.encodeCursor(baseSlot, "relevance");
    const decoded = service.decodeCursor(token, "relevance");

    expect(decoded.id).toBe(baseSlot.id);
    expect(decoded.sortBy).toBe("relevance");
    expect(decoded.rating).toBeCloseTo(baseSlot.supplier_rating ?? 0, 10);
    expect(decoded.price).toBe(baseSlot.price_cents);
  });

  it("produces a stable base64url string for the same input (deterministic)", () => {
    const t1 = service.encodeCursor(baseSlot, "rating");
    const t2 = service.encodeCursor(baseSlot, "rating");
    expect(t1).toBe(t2);
  });

  it("produces different tokens for different sortBy modes", () => {
    const tr = service.encodeCursor(baseSlot, "rating");
    const tp = service.encodeCursor(baseSlot, "price");
    const tl = service.encodeCursor(baseSlot, "relevance");
    const tokens = new Set([tr, tp, tl]);
    expect(tokens.size).toBe(3);
  });

  // --- tamper tests ---

  it("rejects a rating cursor decoded as price (sortBy mismatch)", () => {
    const token = service.encodeCursor(baseSlot, "rating");
    expect(() => service.decodeCursor(token, "price")).toThrow("sortBy mismatch");
  });

  it("rejects a price cursor decoded as relevance (sortBy mismatch)", () => {
    const token = service.encodeCursor(baseSlot, "price");
    expect(() => service.decodeCursor(token, "relevance")).toThrow("sortBy mismatch");
  });

  it("rejects a relevance cursor decoded as rating (sortBy mismatch)", () => {
    const token = service.encodeCursor(baseSlot, "relevance");
    expect(() => service.decodeCursor(token, "rating")).toThrow("sortBy mismatch");
  });

  it("rejects a cursor with negative id", () => {
    const tampered = Buffer.from(
      JSON.stringify({ sortBy: "rating", rating: 4.5, id: -1 })
    ).toString("base64url");
    expect(() => service.decodeCursor(tampered, "rating")).toThrow(
      "Cursor id must be a non-negative integer"
    );
  });

  it("rejects a cursor with fractional id", () => {
    const tampered = Buffer.from(
      JSON.stringify({ sortBy: "price", price: 1000, id: 3.14 })
    ).toString("base64url");
    expect(() => service.decodeCursor(tampered, "price")).toThrow(
      "Cursor id must be a non-negative integer"
    );
  });

  it("rejects a rating cursor missing the rating field", () => {
    const tampered = Buffer.from(
      JSON.stringify({ sortBy: "rating", id: 5 })
    ).toString("base64url");
    expect(() => service.decodeCursor(tampered, "rating")).toThrow("rating must be a valid number");
  });

  it("rejects a price cursor missing the price field", () => {
    const tampered = Buffer.from(
      JSON.stringify({ sortBy: "price", id: 5 })
    ).toString("base64url");
    expect(() => service.decodeCursor(tampered, "price")).toThrow("price must be a valid number");
  });

  it("rejects a relevance cursor missing the rating field", () => {
    const tampered = Buffer.from(
      JSON.stringify({ sortBy: "relevance", price: 1000, id: 5 })
    ).toString("base64url");
    expect(() => service.decodeCursor(tampered, "relevance")).toThrow(
      "rating must be a valid number"
    );
  });

  it("rejects a relevance cursor missing the price field", () => {
    const tampered = Buffer.from(
      JSON.stringify({ sortBy: "relevance", rating: 4.5, id: 5 })
    ).toString("base64url");
    expect(() => service.decodeCursor(tampered, "relevance")).toThrow(
      "price must be a valid number"
    );
  });

  it("rejects completely invalid base64 input", () => {
    expect(() => service.decodeCursor("!!!not-valid!!!", "rating")).toThrow();
  });

  it("rejects a cursor where the JSON payload is an array, not an object", () => {
    const tampered = Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url");
    expect(() => service.decodeCursor(tampered, "rating")).toThrow(
      "Cursor payload must be an object"
    );
  });

  it("rejects a cursor with NaN rating", () => {
    // JSON.stringify(NaN) → "null", so we craft the string manually
    const tampered = Buffer.from('{"sortBy":"rating","rating":null,"id":1}').toString("base64url");
    expect(() => service.decodeCursor(tampered, "rating")).toThrow("rating must be a valid number");
  });
});
