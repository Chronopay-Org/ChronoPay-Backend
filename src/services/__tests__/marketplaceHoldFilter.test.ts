/**
 * Tests for #472 – refundable-hold visibility filter.
 *
 * Verifies that:
 *  - suppressHeld=true (default) excludes slots with active holds
 *  - suppressHeld=false shows held slots
 *  - showHeldReleaseEta=true attaches heldReleaseEta when suppressHeld=false
 *  - policy toggle (showHeldReleaseEta) does not leak ETA when suppressHeld=true
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { MarketplaceSearchService } from "../marketplaceSearchService.js";
import { MarketplaceSearchQuery } from "../../validation/marketplaceSearchSchema.js";

const HOLD_EXPIRES_ISO = new Date("2026-07-28T13:00:00Z").toISOString();

// ─── Minimal mock pool ────────────────────────────────────────────────────────

type MockRow = {
  id: number;
  professional_id: string;
  start_time: string;
  end_time: string;
  category: string;
  price_cents: number;
  supplier_rating: number;
  status: string;
  created_at: string;
  held_release_eta?: string | null;
};

class MockPool {
  public rows: MockRow[] = [];
  public lastSql = "";
  public lastParams: unknown[] = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.lastSql = sql;
    this.lastParams = params;

    if (sql.includes("COUNT(*)")) {
      const visible = this.visibleRows(sql);
      return { rows: [{ total: String(visible.length) }] };
    }

    const visible = this.visibleRows(sql);
    return { rows: visible };
  }

  /** Simulate the NOT EXISTS / suppression filter the real DB would apply. */
  private visibleRows(sql: string): MockRow[] {
    const suppressHeld = sql.includes("NOT EXISTS");
    return this.rows.filter((r) => {
      if (suppressHeld) {
        // Simulate: row is hidden when it is held (held_release_eta is set)
        return r.held_release_eta == null;
      }
      return true;
    });
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeQuery(overrides: Partial<MarketplaceSearchQuery> = {}): MarketplaceSearchQuery {
  return {
    page: 1,
    limit: 10,
    sortBy: "relevance",
    suppressHeld: true,
    showHeldReleaseEta: false,
    includeFacets: false,
    diversify: false,
    ...overrides,
  };
}

function makeAvailableRow(id: number): MockRow {
  return {
    id,
    professional_id: `pro-${id}`,
    start_time: "2026-08-01T09:00:00Z",
    end_time: "2026-08-01T10:00:00Z",
    category: "consulting",
    price_cents: 5000,
    supplier_rating: 4.2,
    status: "available",
    created_at: "2026-07-01T00:00:00Z",
    held_release_eta: null,
  };
}

function makeHeldRow(id: number): MockRow {
  return {
    ...makeAvailableRow(id),
    held_release_eta: HOLD_EXPIRES_ISO,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MarketplaceSearchService – hold visibility filter (#472)", () => {
  let pool: MockPool;
  let service: MarketplaceSearchService;

  beforeEach(() => {
    pool = new MockPool();
    service = new MarketplaceSearchService(pool as any);
  });

  it("default: suppressHeld=true excludes held slots from results", async () => {
    pool.rows = [makeAvailableRow(1), makeHeldRow(2), makeAvailableRow(3)];

    const result = await service.search(makeQuery({ suppressHeld: true }));

    expect(result.slots).toHaveLength(2);
    expect(result.slots.map((s) => s.id)).toEqual([1, 3]);
  });

  it("suppressHeld=true emits NOT EXISTS predicate in SQL", async () => {
    pool.rows = [makeAvailableRow(1)];
    await service.search(makeQuery({ suppressHeld: true }));

    expect(pool.lastSql).toContain("NOT EXISTS");
    expect(pool.lastSql).toContain("slot_holds");
    expect(pool.lastSql).toContain("released_at IS NULL");
    expect(pool.lastSql).toContain("expires_at > NOW()");
  });

  it("suppressHeld=false does NOT emit NOT EXISTS predicate", async () => {
    pool.rows = [makeAvailableRow(1), makeHeldRow(2)];
    await service.search(makeQuery({ suppressHeld: false, showHeldReleaseEta: false }));

    expect(pool.lastSql).not.toContain("NOT EXISTS");
  });

  it("suppressHeld=false returns held and available slots", async () => {
    pool.rows = [makeAvailableRow(1), makeHeldRow(2)];

    const result = await service.search(makeQuery({ suppressHeld: false, showHeldReleaseEta: false }));

    expect(result.slots).toHaveLength(2);
  });

  it("showHeldReleaseEta=true with suppressHeld=false includes held_release_eta subquery", async () => {
    pool.rows = [makeHeldRow(10)];
    await service.search(makeQuery({ suppressHeld: false, showHeldReleaseEta: true }));

    expect(pool.lastSql).toContain("held_release_eta");
  });

  it("showHeldReleaseEta=true with suppressHeld=true does NOT include ETA subquery (slots are not returned)", async () => {
    pool.rows = [makeAvailableRow(1)];
    await service.search(makeQuery({ suppressHeld: true, showHeldReleaseEta: true }));

    // suppressHeld=true means held slots are already excluded; no ETA column needed
    expect(pool.lastSql).not.toContain("held_release_eta");
  });

  it("showHeldReleaseEta=false with suppressHeld=false omits ETA subquery", async () => {
    pool.rows = [makeHeldRow(5)];
    await service.search(makeQuery({ suppressHeld: false, showHeldReleaseEta: false }));

    expect(pool.lastSql).not.toContain("held_release_eta");
  });

  it("returns total count excluding held slots when suppressHeld=true", async () => {
    pool.rows = [makeAvailableRow(1), makeHeldRow(2), makeHeldRow(3)];

    const result = await service.search(makeQuery({ suppressHeld: true }));

    expect(result.total).toBe(1);
  });

  it("returns total count including held slots when suppressHeld=false", async () => {
    pool.rows = [makeAvailableRow(1), makeHeldRow(2), makeHeldRow(3)];

    const result = await service.search(makeQuery({ suppressHeld: false }));

    expect(result.total).toBe(3);
  });
});
