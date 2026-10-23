/**
 * src/models/__tests__/materializedOccurrence.test.ts
 *
 * Dedicated test suite for src/models/materializedOccurrence.ts.
 *
 * Coverage targets:
 *   MaterializedOccurrence (interface shape)
 *     - All required fields present and correctly typed
 *
 *   BulkUpsertOccurrenceInput (interface shape)
 *     - All required fields present and correctly typed
 *
 *   MaterializedOccurrenceRepository (contract, via InMemory implementation)
 *     - bulkUpsert  — happy path: inserts and returns occurrences
 *     - bulkUpsert  — replaces all existing occurrences for the same seriesId
 *     - bulkUpsert  — empty occurrenceDates → returns []
 *     - bulkUpsert  — generates unique ids per occurrence
 *     - bulkUpsert  — returned objects are defensive clones
 *     - findBySeriesId — returns occurrences within range at latest version
 *     - findBySeriesId — excludes occurrences outside the date range
 *     - findBySeriesId — uses latest seriesVersion when multiple versions exist
 *     - findBySeriesId — returns [] for unknown seriesId
 *     - findBySeriesId — results are sorted ascending by occurrenceDate
 *     - findBySeriesId — returns [] when all entries are stale versions
 *     - cleanStaleVersions — removes entries with version < currentVersion
 *     - cleanStaleVersions — keeps entries with version >= currentVersion
 *     - cleanStaleVersions — returns correct removed count
 *     - cleanStaleVersions — returns 0 when nothing to remove
 *     - cleanExpired — removes entries whose occurrenceDate < beforeMs
 *     - cleanExpired — keeps entries whose occurrenceDate >= beforeMs
 *     - cleanExpired — returns correct removed count
 *     - cleanExpired — returns 0 when nothing expired
 *     - deleteBySeriesId — removes all entries for the series
 *     - deleteBySeriesId — does not affect other series
 *     - deleteBySeriesId — returns correct removed count
 *     - deleteBySeriesId — returns 0 for unknown seriesId
 *     - reset() — clears the store and resets id counter
 *     - State transitions: version upgrade replaces, stale cleanup, expiry cleanup
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  InMemoryMaterializedOccurrenceRepository,
  type MaterializedOccurrence,
  type BulkUpsertOccurrenceInput,
} from "../materializedOccurrence.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW_MS = 1_750_000_000_000; // fixed reference time

function makeUpsertInput(
  overrides: Partial<BulkUpsertOccurrenceInput> = {},
): BulkUpsertOccurrenceInput {
  return {
    seriesId: "series-A",
    seriesVersion: 1,
    occurrenceDates: [NOW_MS, NOW_MS + 86_400_000, NOW_MS + 172_800_000],
    materializedAt: NOW_MS,
    ...overrides,
  };
}

// ─── Interface shape checks ───────────────────────────────────────────────────

describe("MaterializedOccurrence interface", () => {
  it("accepts a fully-specified object without TypeScript errors", () => {
    const occ: MaterializedOccurrence = {
      id: "occ-1",
      seriesId: "series-A",
      seriesVersion: 1,
      occurrenceDate: NOW_MS,
      materializedAt: NOW_MS,
      createdAt: NOW_MS,
    };
    // If the interface were wrong this assignment would not compile.
    expect(occ.id).toBe("occ-1");
    expect(occ.seriesId).toBe("series-A");
    expect(occ.seriesVersion).toBe(1);
    expect(typeof occ.occurrenceDate).toBe("number");
    expect(typeof occ.materializedAt).toBe("number");
    expect(typeof occ.createdAt).toBe("number");
  });
});

describe("BulkUpsertOccurrenceInput interface", () => {
  it("accepts a fully-specified object without TypeScript errors", () => {
    const input: BulkUpsertOccurrenceInput = {
      seriesId: "series-B",
      seriesVersion: 3,
      occurrenceDates: [NOW_MS, NOW_MS + 1000],
      materializedAt: NOW_MS,
    };
    expect(input.seriesId).toBe("series-B");
    expect(input.occurrenceDates).toHaveLength(2);
  });
});

// ─── InMemoryMaterializedOccurrenceRepository ─────────────────────────────────

describe("InMemoryMaterializedOccurrenceRepository", () => {
  let repo: InMemoryMaterializedOccurrenceRepository;

  beforeEach(() => {
    repo = new InMemoryMaterializedOccurrenceRepository();
    repo.reset();
  });

  // ── bulkUpsert ───────────────────────────────────────────────────────────────

  describe("bulkUpsert", () => {
    it("returns the inserted occurrences with generated ids", async () => {
      const input = makeUpsertInput({ occurrenceDates: [NOW_MS, NOW_MS + 1000] });
      const result = await repo.bulkUpsert(input);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBeTruthy();
      expect(result[1].id).toBeTruthy();
      expect(result[0].id).not.toBe(result[1].id);
    });

    it("sets seriesId and seriesVersion from the input", async () => {
      const result = await repo.bulkUpsert(
        makeUpsertInput({ seriesId: "s-X", seriesVersion: 7 }),
      );
      expect(result.every((o) => o.seriesId === "s-X")).toBe(true);
      expect(result.every((o) => o.seriesVersion === 7)).toBe(true);
    });

    it("sets occurrenceDate and materializedAt from the input", async () => {
      const dates = [NOW_MS + 100, NOW_MS + 200];
      const result = await repo.bulkUpsert(makeUpsertInput({ occurrenceDates: dates, materializedAt: NOW_MS + 99 }));

      expect(result[0].occurrenceDate).toBe(NOW_MS + 100);
      expect(result[1].occurrenceDate).toBe(NOW_MS + 200);
      expect(result[0].materializedAt).toBe(NOW_MS + 99);
    });

    it("returns an empty array when occurrenceDates is empty", async () => {
      const result = await repo.bulkUpsert(makeUpsertInput({ occurrenceDates: [] }));
      expect(result).toEqual([]);
    });

    it("replaces all existing occurrences for the same seriesId", async () => {
      // First upsert: 3 occurrences
      await repo.bulkUpsert(makeUpsertInput({ occurrenceDates: [NOW_MS, NOW_MS + 1000, NOW_MS + 2000] }));

      // Second upsert: 2 new occurrences — must replace the first 3
      const result = await repo.bulkUpsert(
        makeUpsertInput({ occurrenceDates: [NOW_MS + 5000, NOW_MS + 6000], seriesVersion: 2 }),
      );
      expect(result).toHaveLength(2);

      // Only the new ones should survive in findBySeriesId
      const found = await repo.findBySeriesId("series-A", NOW_MS, NOW_MS + 10_000);
      expect(found).toHaveLength(2);
      expect(found.map((o) => o.occurrenceDate).sort()).toEqual([NOW_MS + 5000, NOW_MS + 6000]);
    });

    it("does not replace occurrences for a different seriesId", async () => {
      await repo.bulkUpsert(makeUpsertInput({ seriesId: "s-1" }));
      await repo.bulkUpsert(makeUpsertInput({ seriesId: "s-2", occurrenceDates: [NOW_MS] }));

      const s1 = await repo.findBySeriesId("s-1", NOW_MS - 1, NOW_MS + 1_000_000);
      expect(s1).toHaveLength(3); // original 3 intact
    });

    it("returns defensive clones, not the internal store reference", async () => {
      const [result] = await repo.bulkUpsert(makeUpsertInput({ occurrenceDates: [NOW_MS] }));

      // Mutating the returned object should not affect subsequent reads
      (result as { id: string }).id = "mutated";
      const found = await repo.findBySeriesId("series-A", NOW_MS - 1, NOW_MS + 1);
      expect(found[0].id).not.toBe("mutated");
    });

    it("generates globally unique ids even across multiple bulkUpsert calls", async () => {
      const r1 = await repo.bulkUpsert(makeUpsertInput({ seriesId: "s-1", occurrenceDates: [NOW_MS] }));
      const r2 = await repo.bulkUpsert(makeUpsertInput({ seriesId: "s-2", occurrenceDates: [NOW_MS + 1] }));

      expect(r1[0].id).not.toBe(r2[0].id);
    });
  });

  // ── findBySeriesId ────────────────────────────────────────────────────────────

  describe("findBySeriesId", () => {
    it("returns occurrences within the [fromMs, toMs] range", async () => {
      await repo.bulkUpsert(
        makeUpsertInput({ occurrenceDates: [NOW_MS, NOW_MS + 1000, NOW_MS + 2000, NOW_MS + 3000] }),
      );

      const result = await repo.findBySeriesId("series-A", NOW_MS + 500, NOW_MS + 2500);
      expect(result.map((o) => o.occurrenceDate)).toEqual([NOW_MS + 1000, NOW_MS + 2000]);
    });

    it("includes boundary dates (fromMs and toMs are inclusive)", async () => {
      await repo.bulkUpsert(
        makeUpsertInput({ occurrenceDates: [NOW_MS, NOW_MS + 1000] }),
      );

      const result = await repo.findBySeriesId("series-A", NOW_MS, NOW_MS + 1000);
      expect(result).toHaveLength(2);
    });

    it("returns [] for an unknown seriesId", async () => {
      const result = await repo.findBySeriesId("nonexistent", NOW_MS, NOW_MS + 99999);
      expect(result).toEqual([]);
    });

    it("returns results sorted ascending by occurrenceDate", async () => {
      await repo.bulkUpsert(
        makeUpsertInput({ occurrenceDates: [NOW_MS + 300, NOW_MS + 100, NOW_MS + 200] }),
      );
      const result = await repo.findBySeriesId("series-A", NOW_MS, NOW_MS + 1000);

      const dates = result.map((o) => o.occurrenceDate);
      expect(dates).toEqual([...dates].sort((a, b) => a - b));
    });

    it("only returns occurrences at the latest seriesVersion", async () => {
      // Upsert version 1 (3 dates), then version 2 (2 dates) — both stored, only v2 visible
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 1, occurrenceDates: [NOW_MS] }));
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 2, occurrenceDates: [NOW_MS + 5000, NOW_MS + 6000] }));

      const result = await repo.findBySeriesId("series-A", NOW_MS - 1, NOW_MS + 100_000);
      expect(result.every((o) => o.seriesVersion === 2)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it("returns [] when all entries have a stale version compared to the max", async () => {
      // Insert v1, then v2 with an out-of-range date — v1 is stale, v2 out-of-range
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 1, occurrenceDates: [NOW_MS + 100] }));
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 2, occurrenceDates: [NOW_MS + 99_000_000] }));

      // Query a range that only covers v1 dates — v1 is stale, so result is []
      const result = await repo.findBySeriesId("series-A", NOW_MS, NOW_MS + 200);
      expect(result).toEqual([]);
    });
  });

  // ── cleanStaleVersions ────────────────────────────────────────────────────────

  describe("cleanStaleVersions", () => {
    it("removes entries with seriesVersion strictly less than currentVersion", async () => {
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 1, occurrenceDates: [NOW_MS] }));
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 2, occurrenceDates: [NOW_MS + 1000] }));
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 3, occurrenceDates: [NOW_MS + 2000] }));

      const removed = await repo.cleanStaleVersions("series-A", 3);
      expect(removed).toBe(2); // v1 and v2 gone
    });

    it("keeps entries with seriesVersion >= currentVersion", async () => {
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 3, occurrenceDates: [NOW_MS] }));

      const removed = await repo.cleanStaleVersions("series-A", 3);
      expect(removed).toBe(0);

      const remaining = await repo.findBySeriesId("series-A", NOW_MS - 1, NOW_MS + 1);
      expect(remaining).toHaveLength(1);
    });

    it("returns 0 when there is nothing to remove", async () => {
      const removed = await repo.cleanStaleVersions("series-A", 1);
      expect(removed).toBe(0);
    });

    it("does not affect other series", async () => {
      await repo.bulkUpsert(makeUpsertInput({ seriesId: "s-A", seriesVersion: 1, occurrenceDates: [NOW_MS] }));
      await repo.bulkUpsert(makeUpsertInput({ seriesId: "s-B", seriesVersion: 1, occurrenceDates: [NOW_MS + 1000] }));

      await repo.cleanStaleVersions("s-A", 99); // wipe all of s-A

      const remaining = await repo.findBySeriesId("s-B", NOW_MS, NOW_MS + 2000);
      expect(remaining).toHaveLength(1);
    });
  });

  // ── cleanExpired ──────────────────────────────────────────────────────────────

  describe("cleanExpired", () => {
    it("removes entries whose occurrenceDate is strictly less than beforeMs", async () => {
      await repo.bulkUpsert(
        makeUpsertInput({ occurrenceDates: [NOW_MS - 2000, NOW_MS - 1000, NOW_MS, NOW_MS + 1000] }),
      );

      const removed = await repo.cleanExpired(NOW_MS);
      expect(removed).toBe(2); // NOW_MS - 2000 and NOW_MS - 1000
    });

    it("keeps entries whose occurrenceDate >= beforeMs", async () => {
      await repo.bulkUpsert(makeUpsertInput({ occurrenceDates: [NOW_MS, NOW_MS + 1000] }));

      const removed = await repo.cleanExpired(NOW_MS);
      expect(removed).toBe(0);
    });

    it("returns 0 when the store is empty", async () => {
      const removed = await repo.cleanExpired(NOW_MS);
      expect(removed).toBe(0);
    });

    it("removes entries across all series whose occurrenceDate is expired", async () => {
      await repo.bulkUpsert(makeUpsertInput({ seriesId: "s-1", occurrenceDates: [NOW_MS - 100] }));
      await repo.bulkUpsert(makeUpsertInput({ seriesId: "s-2", occurrenceDates: [NOW_MS + 100] }));

      const removed = await repo.cleanExpired(NOW_MS);
      expect(removed).toBe(1);

      const s2Remaining = await repo.findBySeriesId("s-2", NOW_MS, NOW_MS + 200);
      expect(s2Remaining).toHaveLength(1);
    });
  });

  // ── deleteBySeriesId ──────────────────────────────────────────────────────────

  describe("deleteBySeriesId", () => {
    it("removes all entries for the specified seriesId", async () => {
      await repo.bulkUpsert(makeUpsertInput({ occurrenceDates: [NOW_MS, NOW_MS + 1000] }));

      const removed = await repo.deleteBySeriesId("series-A");
      expect(removed).toBe(2);

      const remaining = await repo.findBySeriesId("series-A", NOW_MS - 1, NOW_MS + 99999);
      expect(remaining).toHaveLength(0);
    });

    it("returns 0 for an unknown seriesId", async () => {
      const removed = await repo.deleteBySeriesId("nonexistent-series");
      expect(removed).toBe(0);
    });

    it("does not affect occurrences belonging to other series", async () => {
      await repo.bulkUpsert(makeUpsertInput({ seriesId: "s-keep", occurrenceDates: [NOW_MS] }));
      await repo.bulkUpsert(makeUpsertInput({ seriesId: "s-delete", occurrenceDates: [NOW_MS + 1000] }));

      await repo.deleteBySeriesId("s-delete");

      const remaining = await repo.findBySeriesId("s-keep", NOW_MS - 1, NOW_MS + 1);
      expect(remaining).toHaveLength(1);
    });
  });

  // ── reset ─────────────────────────────────────────────────────────────────────

  describe("reset", () => {
    it("clears all stored occurrences", async () => {
      await repo.bulkUpsert(makeUpsertInput());
      repo.reset();

      const result = await repo.findBySeriesId("series-A", 0, Number.MAX_SAFE_INTEGER);
      expect(result).toEqual([]);
    });

    it("resets the id counter so ids start from occ-1 again", async () => {
      await repo.bulkUpsert(makeUpsertInput({ occurrenceDates: [NOW_MS] }));
      repo.reset();

      const [occ] = await repo.bulkUpsert(makeUpsertInput({ occurrenceDates: [NOW_MS] }));
      expect(occ.id).toBe("occ-1");
    });
  });

  // ── Primary state transitions ─────────────────────────────────────────────────

  describe("primary state transitions", () => {
    it("version upgrade: new bulkUpsert replaces old occurrences and new version is visible", async () => {
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 1, occurrenceDates: [NOW_MS] }));
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 2, occurrenceDates: [NOW_MS + 5000] }));

      const occs = await repo.findBySeriesId("series-A", NOW_MS - 1, NOW_MS + 10_000);
      expect(occs).toHaveLength(1);
      expect(occs[0].seriesVersion).toBe(2);
      expect(occs[0].occurrenceDate).toBe(NOW_MS + 5000);
    });

    it("cleanStaleVersions after upgrade removes old rows but keeps current", async () => {
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 1, occurrenceDates: [NOW_MS] }));
      await repo.bulkUpsert(makeUpsertInput({ seriesVersion: 2, occurrenceDates: [NOW_MS + 1000] }));

      // Simulate: both versions coexist because bulkUpsert replaced all, but
      // in a real PG impl stale rows may linger — cleanStaleVersions is the guard.
      const removed = await repo.cleanStaleVersions("series-A", 2);
      // After a bulkUpsert, only version 2 remains in memory (bulkUpsert already deleted v1).
      // cleanStaleVersions has nothing to remove → 0.
      expect(removed).toBe(0);

      const occs = await repo.findBySeriesId("series-A", NOW_MS - 1, NOW_MS + 2000);
      expect(occs).toHaveLength(1);
    });

    it("cleanExpired after date passage removes past occurrences", async () => {
      const past = NOW_MS - 100_000;
      const future = NOW_MS + 100_000;
      await repo.bulkUpsert(makeUpsertInput({ occurrenceDates: [past, future] }));

      await repo.cleanExpired(NOW_MS);

      const remaining = await repo.findBySeriesId("series-A", past - 1, future + 1);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].occurrenceDate).toBe(future);
    });

    it("deleteBySeriesId after a series is removed leaves no trace", async () => {
      await repo.bulkUpsert(makeUpsertInput({ occurrenceDates: [NOW_MS, NOW_MS + 1000] }));
      await repo.deleteBySeriesId("series-A");

      const result = await repo.findBySeriesId("series-A", 0, Number.MAX_SAFE_INTEGER);
      expect(result).toEqual([]);
    });

    it("multiple series can be managed independently without cross-contamination", async () => {
      await repo.bulkUpsert(makeUpsertInput({ seriesId: "alpha", occurrenceDates: [NOW_MS] }));
      await repo.bulkUpsert(makeUpsertInput({ seriesId: "beta", occurrenceDates: [NOW_MS + 500] }));
      await repo.bulkUpsert(makeUpsertInput({ seriesId: "gamma", occurrenceDates: [NOW_MS + 1000] }));

      await repo.deleteBySeriesId("beta");

      const alpha = await repo.findBySeriesId("alpha", NOW_MS - 1, NOW_MS + 1);
      const beta = await repo.findBySeriesId("beta", NOW_MS, NOW_MS + 600);
      const gamma = await repo.findBySeriesId("gamma", NOW_MS + 999, NOW_MS + 1001);

      expect(alpha).toHaveLength(1);
      expect(beta).toHaveLength(0);
      expect(gamma).toHaveLength(1);
    });
  });
});
