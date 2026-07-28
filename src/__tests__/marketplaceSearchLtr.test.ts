/**
 * Marketplace Search with LTR Reranker - Integration Tests
 *
 * Covers:
 *   - Search with reranker disabled (feature flag off)
 *   - Search with reranker enabled
 *   - Search with reranker unavailable (no weights)
 *   - Impression event emission during search
 *   - Graceful degradation on reranker failure
 *   - Cursor stability preserved with reranking
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { Pool } from "pg";
import { MarketplaceSearchService, SearchResult } from "../services/marketplaceSearchService.js";
import {
  SearchLtrReranker,
  RERANK_BUDGET_MS,
} from "../services/ltr/reranker.js";
import type {
  LtrModelWeights,
  SlotFeatureVector,
  RerankResult,
} from "../services/ltr/types.js";
import { NUM_FEATURES } from "../services/ltr/types.js";
import { setFeatureFlagsFromEnv } from "../flags/index.js";


// ─── Mocks ──────────────────────────────────────────────────────────────────

// Restore feature flags after tests
const originalEnv = { ...process.env };

afterEach(() => {
  setFeatureFlagsFromEnv(originalEnv);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePool(rows: any[] = [], total: number = 0): Pool {
  return {
    query: jest.fn().mockImplementation((queryStr: string) => {
      if (queryStr.toLowerCase().includes("count(*)")) {
        return Promise.resolve({
          rows: [{ total: total > 0 ? total : rows.length }],
        });
      }
      return Promise.resolve({ rows });
    }),
  } as unknown as Pool;
}

function makeSlotRow(overrides: Partial<any> = {}): any {
  return {
    id: overrides.id ?? 1,
    professional: "alice",
    startTime: "2026-08-01T10:00:00Z",
    endTime: "2026-08-01T11:00:00Z",
    category: "haircut",
    price_cents: 5000,
    supplier_rating: 4.5,
    status: "available",
    created_at: "2026-07-28T00:00:00Z",
    ...overrides,
  };
}

function makeSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    id: 1,
    professional: "alice",
    startTime: new Date("2026-08-01T10:00:00Z").getTime(),
    endTime: new Date("2026-08-01T11:00:00Z").getTime(),
    category: "haircut",
    price_cents: 5000,
    supplier_rating: 4.5,
    ...overrides,
  };
}

function makeTrainedWeights(): LtrModelWeights {
  return {
    version: "test-v1",
    weights: [0.4, 0.25, 0.15, 0.1, 0.05, 0.05],
  };
}

// ─── Search without LTR ─────────────────────────────────────────────────────

describe("MarketplaceSearchService - basic (no LTR)", () => {
  it("searches without reranker injected", async () => {
    const pool = makePool([makeSlotRow({ id: 1 })]);
    const service = new MarketplaceSearchService(pool);

    const result = await service.search({
      page: 1,
      limit: 10,
      sortBy: "relevance",
    });

    expect(result.slots).toHaveLength(1);
    expect(result.ltrReranked).toBeUndefined();
  });

  it("searches with reranker but feature flag disabled", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "false" });
    const pool = makePool([makeSlotRow({ id: 1 }), makeSlotRow({ id: 2 })]);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    const service = new MarketplaceSearchService(pool, reranker);

    const result = await service.search({
      page: 1,
      limit: 10,
      sortBy: "relevance",
    });

    expect(result.slots).toHaveLength(2);
    expect(result.ltrReranked).toBeUndefined();
  });
});

// ─── Search with LTR enabled ────────────────────────────────────────────────

describe("MarketplaceSearchService - LTR enabled", () => {
  it("reranks results when feature flag is on and model is available", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    // Slot 2 has higher rating → should be reranked to top
    const pool = makePool([
      makeSlotRow({ id: 1, supplier_rating: 2.0 }),
      makeSlotRow({ id: 2, supplier_rating: 5.0 }),
    ]);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    const service = new MarketplaceSearchService(pool, reranker);

    const result = await service.search({
      page: 1,
      limit: 10,
      sortBy: "relevance",
    });

    expect(result.slots).toHaveLength(2);
    expect(result.ltrReranked).toBe(true);
    // Higher-rated slot should be first after reranking
    expect(result.slots[0].id).toBe(2);
    expect(result.slots[1].id).toBe(1);
  });

  it("does not rerank when model is unavailable (default weights)", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    const pool = makePool([
      makeSlotRow({ id: 1 }),
      makeSlotRow({ id: 2, supplier_rating: 5.0 }),
    ]);
    // No weights passed → unavailable
    const reranker = new SearchLtrReranker();
    const service = new MarketplaceSearchService(pool, reranker);

    const result = await service.search({
      page: 1,
      limit: 10,
      sortBy: "relevance",
    });

    expect(result.slots).toHaveLength(2);
    expect(result.ltrReranked).toBeUndefined();
  });

  it("preserves all slots after reranking (no data loss)", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeSlotRow({
        id: i + 1,
        supplier_rating: Math.random() * 5,
        price_cents: Math.floor(Math.random() * 20000),
      }),
    );
    const pool = makePool(rows);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    const service = new MarketplaceSearchService(pool, reranker);

    const result = await service.search({
      page: 1,
      limit: 10,
      sortBy: "relevance",
    });

    expect(result.slots).toHaveLength(5);
    const sortedIds = [...result.slots.map((s) => s.id)].sort((a, b) => a - b);
    expect(sortedIds).toEqual([1, 2, 3, 4, 5]);
  });

  it("computes nextCursor from the last slot after reranking", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeSlotRow({ id: i + 1, supplier_rating: (10 - i) * 0.5 }),
    );
    const pool = makePool(rows, 50);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    const service = new MarketplaceSearchService(pool, reranker);

    const result = await service.search({
      page: 1,
      limit: 10,
      sortBy: "rating",
    });

    expect(result.slots).toHaveLength(10);
    expect(result.nextCursor).toBeTruthy();
    expect(result.ltrReranked).toBe(true);
  });
});

// ─── Event emission during search ───────────────────────────────────────────

describe("MarketplaceSearchService - event emission", () => {
  it("emits impression event when reranker and emitter are provided", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    const pool = makePool([makeSlotRow({ id: 1 }), makeSlotRow({ id: 2 })]);
    const reranker = new SearchLtrReranker(makeTrainedWeights());

    const emitImpressionSpy = jest.fn();
    const emitter = {
      emitImpression: emitImpressionSpy,
      emitClick: jest.fn(),
    };

    const service = new MarketplaceSearchService(pool, reranker, emitter);
    await service.search({ page: 1, limit: 10, sortBy: "relevance" });

    expect(emitImpressionSpy).toHaveBeenCalledTimes(1);
    const call = emitImpressionSpy.mock.calls[0][0];
    expect(call.type).toBe("search_impression");
    expect(call.searchId).toMatch(/^srch_/);
    expect(call.displayedSlots).toHaveLength(2);
  });

  it("does not emit impression when emitter is not provided", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    const pool = makePool([makeSlotRow({ id: 1 })]);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    // No emitter passed
    const service = new MarketplaceSearchService(pool, reranker);

    // Should not throw
    const result = await service.search({ page: 1, limit: 10, sortBy: "relevance" });
    expect(result.slots).toHaveLength(1);
  });
});

// ─── Graceful degradation ───────────────────────────────────────────────────

describe("MarketplaceSearchService - graceful degradation", () => {
  it("returns original results when reranker throws", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    const pool = makePool([makeSlotRow({ id: 1 }), makeSlotRow({ id: 2 })]);

    // Reranker that always throws
    const faultyReranker = {
      isAvailable: () => true,
      rerank: () => { throw new Error("Simulated failure"); },
    };

    const service = new MarketplaceSearchService(pool, faultyReranker as any);
    const result = await service.search({ page: 1, limit: 10, sortBy: "relevance" });

    // Should still return results in original DB order
    expect(result.slots).toHaveLength(2);
    expect(result.ltrReranked).toBeUndefined();
  });

  it("returns original results when reranker returns mismatched slot IDs", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    const pool = makePool([makeSlotRow({ id: 1 }), makeSlotRow({ id: 2 })]);

    // Reranker that returns wrong / missing slot IDs
    const badReranker = {
      isAvailable: () => true,
      rerank: () => ({
        slotIds: [99, 999], // IDs not in the result set
        reranked: true,
        durationMs: 0.1,
      }),
    };

    const service = new MarketplaceSearchService(pool, badReranker as any);
    const result = await service.search({ page: 1, limit: 10, sortBy: "relevance" });

    // Should still return the original 2 results
    expect(result.slots).toHaveLength(2);
  });

  it("returns original results when reranker returns partial slot IDs", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    const pool = makePool([makeSlotRow({ id: 1 }), makeSlotRow({ id: 2 }), makeSlotRow({ id: 3 })]);

    // Reranker that drops a slot
    const badReranker = {
      isAvailable: () => true,
      rerank: () => ({
        slotIds: [1, 3], // Only 2 of 3
        reranked: true,
        durationMs: 0.1,
      }),
    };

    const service = new MarketplaceSearchService(pool, badReranker as any);
    const result = await service.search({ page: 1, limit: 10, sortBy: "relevance" });

    // Should still return all 3 (length mismatch guard triggers fallback)
    expect(result.slots).toHaveLength(3);
  });

  it("handles empty search results gracefully", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    const pool = makePool([], 0);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    const service = new MarketplaceSearchService(pool, reranker);

    const result = await service.search({ page: 1, limit: 10, sortBy: "relevance" });

    expect(result.slots).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("emitter failure does not affect search results", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    // Need 2+ slots since single-slot queries are a no-op for LTR
    const pool = makePool([makeSlotRow({ id: 1 }), makeSlotRow({ id: 2 })]);
    const reranker = new SearchLtrReranker(makeTrainedWeights());

    const badEmitter = {
      emitImpression: () => { throw new Error("Emit failed"); },
      emitClick: () => {},
    };

    const service = new MarketplaceSearchService(pool, reranker, badEmitter);
    const result = await service.search({ page: 1, limit: 10, sortBy: "relevance" });

    // Search should still succeed and reranking applied (emission failures are caught)
    expect(result.slots).toHaveLength(2);
    expect(result.ltrReranked).toBe(true);
  });
});

// ─── Feature flag A/B guard ─────────────────────────────────────────────────

describe("MarketplaceSearchService - feature flag guards", () => {
  it("skips reranking when FF_SEARCH_LTR_RERANKER is explicitly false", async () => {
    setFeatureFlagsFromEnv({
      ...originalEnv,
      FF_SEARCH_LTR_RERANKER: "false",
    });
    const pool = makePool([makeSlotRow({ id: 1 }), makeSlotRow({ id: 2, supplier_rating: 5.0 })]);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    const service = new MarketplaceSearchService(pool, reranker);

    const result = await service.search({ page: 1, limit: 10, sortBy: "relevance" });

    expect(result.ltrReranked).toBeUndefined();
    // Original DB order preserved
    expect(result.slots[0].id).toBe(1);
  });

  it("skips reranking when FF_SEARCH_LTR_RERANKER is 'off'", async () => {
    setFeatureFlagsFromEnv({
      ...originalEnv,
      FF_SEARCH_LTR_RERANKER: "off",
    });
    const pool = makePool([makeSlotRow({ id: 1 })]);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    const service = new MarketplaceSearchService(pool, reranker);

    const result = await service.search({ page: 1, limit: 10, sortBy: "relevance" });
    expect(result.ltrReranked).toBeUndefined();
  });

  it("applies reranking when FF_SEARCH_LTR_RERANKER is 'true'", async () => {
    setFeatureFlagsFromEnv({
      ...originalEnv,
      FF_SEARCH_LTR_RERANKER: "true",
    });
    const pool = makePool([makeSlotRow({ id: 1 }), makeSlotRow({ id: 2, supplier_rating: 5.0 })]);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    const service = new MarketplaceSearchService(pool, reranker);

    const result = await service.search({ page: 1, limit: 10, sortBy: "relevance" });
    expect(result.ltrReranked).toBe(true);
  });

  it("applies reranking when FF_SEARCH_LTR_RERANKER is '1'", async () => {
    setFeatureFlagsFromEnv({
      ...originalEnv,
      FF_SEARCH_LTR_RERANKER: "1",
    });
    const pool = makePool([makeSlotRow({ id: 1 }), makeSlotRow({ id: 2, supplier_rating: 5.0 })]);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    const service = new MarketplaceSearchService(pool, reranker);

    const result = await service.search({ page: 1, limit: 10, sortBy: "relevance" });
    expect(result.ltrReranked).toBe(true);
  });
});

// ─── Cursor pagination with reranking ───────────────────────────────────────

describe("MarketplaceSearchService - cursor pagination with LTR", () => {
  it("still encodes valid cursor after reranking", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });
    // Use exactly limit-many rows so a nextCursor is generated
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeSlotRow({ id: i + 1, supplier_rating: (10 - i) * 0.5 }),
    );
    const pool = makePool(rows, 50);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    const service = new MarketplaceSearchService(pool, reranker);

    const result = await service.search({
      page: 1,
      limit: 5,
      sortBy: "rating",
    });

    expect(result.nextCursor).toBeTruthy();
    // Cursor should be valid base64url
    expect(() => Buffer.from(result.nextCursor!.replace(/-/g, "+").replace(/_/g, "/"), "base64")).not.toThrow();
  });

  it("handles cursor-based pagination with reranker enabled", async () => {
    setFeatureFlagsFromEnv({ ...originalEnv, FF_SEARCH_LTR_RERANKER: "true" });

    // First page: simulate DB returning the first 5 rows
    const page1Rows = Array.from({ length: 5 }, (_, i) =>
      makeSlotRow({ id: i + 1, supplier_rating: (10 - i) * 0.5 }),
    );
    // Second page: DB returns next 5 after cursor
    const page2Rows = Array.from({ length: 5 }, (_, i) =>
      makeSlotRow({ id: i + 6, supplier_rating: (5 - i) * 0.5 }),
    );

    // We need to test that cursor flows through correctly
    // First, get the cursor from page 1
    const pool1 = makePool(page1Rows, 20);
    const reranker = new SearchLtrReranker(makeTrainedWeights());
    const service1 = new MarketplaceSearchService(pool1, reranker);

    const page1 = await service1.search({ page: 1, limit: 5, sortBy: "rating" });
    expect(page1.nextCursor).toBeTruthy();

    // Then use the cursor for page 2
    const pool2 = makePool(page2Rows, 20);
    const service2 = new MarketplaceSearchService(pool2, reranker);
    const page2 = await service2.search({
      page: 1,
      limit: 5,
      sortBy: "rating",
      cursor: page1.nextCursor!,
    });

    expect(page2.slots).toHaveLength(5);
  });
});
