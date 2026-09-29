import { jest } from "@jest/globals";
import {
  InMemoryRecurrenceSeriesRepository,
  type CreateRecurrenceSeriesInput,
  type RecurrenceSeries,
} from "../recurrenceSeries.js";

/**
 * Regression coverage for the failure / empty-result branch in
 * `InMemoryRecurrenceSeriesRepository.updateRRule`:
 *
 *   const index = store.findIndex((s) => s.id === id);
 *   if (index === -1) return null;   // src/models/recurrenceSeries.ts
 *
 * The not-found branch must return `null` — never throw, never create a series
 * and never mutate the store — because `OccurrenceSeriesService.editSeries`
 * relies on that exact contract to raise "Recurrence series not found".
 */

const RRULE_V1 = "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO";
const RRULE_V2 = "DTSTART:20260112T100000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3;BYDAY=MO";
const RRULE_V3 = "DTSTART:20260119T100000Z\nRRULE:FREQ=DAILY;COUNT=2";

// Fake timers pin the clock so the timestamp assertions are exact, not fuzzy.
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();
const T1 = new Date("2026-01-01T00:00:05.000Z").getTime();
const T2 = new Date("2026-01-01T00:00:10.000Z").getTime();

const input = (rrule: string): CreateRecurrenceSeriesInput => ({ rrule });

describe("InMemoryRecurrenceSeriesRepository", () => {
  let repo: InMemoryRecurrenceSeriesRepository;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    // The in-memory store is module-level and shared by every instance, so each
    // test starts from a clean, deterministic state.
    repo = new InMemoryRecurrenceSeriesRepository();
    repo.reset();
  });

  afterEach(() => {
    repo.reset();
    jest.useRealTimers();
  });

  describe("create", () => {
    it("creates a version-1 series with a deterministic id and timestamps", async () => {
      const created = await repo.create(input(RRULE_V1));
      const expected: RecurrenceSeries = {
        id: "series-1",
        rrule: RRULE_V1,
        version: 1,
        createdAt: T0,
        updatedAt: T0,
      };

      expect(created).toEqual(expected);
    });

    it("assigns monotonically increasing ids", async () => {
      await repo.create(input(RRULE_V1));

      const second = await repo.create(input(RRULE_V2));

      expect(second.id).toBe("series-2");
    });
  });

  describe("findById - neighbouring empty-result path", () => {
    it("returns a clone of the stored series for a known id", async () => {
      const created = await repo.create(input(RRULE_V1));

      const found = await repo.findById(created.id);

      expect(found).toEqual(created);
      expect(found).not.toBe(created);
    });

    it("returns null for an unknown id", async () => {
      await repo.create(input(RRULE_V1));

      await expect(repo.findById("missing")).resolves.toBeNull();
    });

    it("returns null when the store is empty", async () => {
      await expect(repo.findById("series-1")).resolves.toBeNull();
    });
  });

  describe("updateRRule - not-found branch (index === -1)", () => {
    it("returns null instead of throwing when no series matches the id", async () => {
      await repo.create(input(RRULE_V1));

      const result = await repo.updateRRule("does-not-exist", RRULE_V2);

      expect(result).toBeNull();
    });

    it("leaves the stored series untouched on the not-found path", async () => {
      const existing = await repo.create(input(RRULE_V1));
      const before = { ...existing };

      await repo.updateRRule("does-not-exist", RRULE_V2);

      const all = await repo.listAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(before);
      expect(await repo.findById(existing.id)).toEqual(before);
    });

    it("does not create a series when the id is unknown", async () => {
      const result = await repo.updateRRule("ghost", RRULE_V2);

      expect(result).toBeNull();
      await expect(repo.listAll()).resolves.toEqual([]);
    });

    it("returns null when the store is empty", async () => {
      const result = await repo.updateRRule("series-1", RRULE_V2);

      expect(result).toBeNull();
    });

    it("returns null for an empty-string id", async () => {
      await repo.create(input(RRULE_V1));

      const result = await repo.updateRRule("", RRULE_V2);

      expect(result).toBeNull();
    });

    it("returns null for an id that no longer exists after a store reset", async () => {
      await repo.create(input(RRULE_V1));
      repo.reset();

      const result = await repo.updateRRule("series-1", RRULE_V2);

      expect(result).toBeNull();
    });
  });

  describe("updateRRule - success path", () => {
    it("updates the rrule, bumps the version and keeps identity and createdAt", async () => {
      const created = await repo.create(input(RRULE_V1));
      jest.setSystemTime(T1);

      const updated = await repo.updateRRule(created.id, RRULE_V2);
      const expected: RecurrenceSeries = {
        id: created.id,
        rrule: RRULE_V2,
        version: 2,
        createdAt: T0,
        updatedAt: T1,
      };

      expect(updated).toEqual(expected);
    });

    it("bumps the version on every successful edit", async () => {
      const created = await repo.create(input(RRULE_V1));

      jest.setSystemTime(T1);
      const second = await repo.updateRRule(created.id, RRULE_V2);
      jest.setSystemTime(T2);
      const third = await repo.updateRRule(created.id, RRULE_V3);

      expect(second?.version).toBe(2);
      expect(third?.version).toBe(3);
      expect(third?.createdAt).toBe(T0);
      expect(third?.updatedAt).toBe(T2);
    });

    it("updates only the first element when several series exist", async () => {
      const first = await repo.create(input(RRULE_V1));
      const second = await repo.create(input(RRULE_V1));
      const third = await repo.create(input(RRULE_V1));
      jest.setSystemTime(T1);

      const updated = await repo.updateRRule(first.id, RRULE_V2);

      expect(updated?.id).toBe(first.id);
      expect(updated?.version).toBe(2);

      const all = await repo.listAll();
      expect(all.map((s) => s.id)).toEqual([first.id, second.id, third.id]);
      expect(all[1]).toEqual(second);
      expect(all[2]).toEqual(third);
    });

    it("updates only the last element when several series exist", async () => {
      const first = await repo.create(input(RRULE_V1));
      const last = await repo.create(input(RRULE_V1));
      jest.setSystemTime(T1);

      const updated = await repo.updateRRule(last.id, RRULE_V2);

      expect(updated?.id).toBe(last.id);
      expect(updated?.version).toBe(2);

      const all = await repo.listAll();
      expect(all[0]).toEqual(first);
      expect(all[1]?.version).toBe(2);
      expect(all[1]?.rrule).toBe(RRULE_V2);
    });

    it("returns a clone that does not alias the stored series", async () => {
      const created = await repo.create(input(RRULE_V1));

      const updated = await repo.updateRRule(created.id, RRULE_V2);
      if (!updated) throw new Error("expected the series to be updated");
      updated.rrule = "MUTATED";
      updated.version = 99;

      const stored = await repo.findById(created.id);
      expect(stored?.rrule).toBe(RRULE_V2);
      expect(stored?.version).toBe(2);
    });
  });

  describe("delete - neighbouring not-found branch", () => {
    it("returns false for an unknown id and keeps the store intact", async () => {
      const created = await repo.create(input(RRULE_V1));

      const result = await repo.delete("does-not-exist");

      expect(result).toBe(false);
      await expect(repo.listAll()).resolves.toEqual([created]);
    });

    it("returns false when the store is empty", async () => {
      const result = await repo.delete("series-1");

      expect(result).toBe(false);
    });

    it("returns true and removes the series for a known id", async () => {
      const created = await repo.create(input(RRULE_V1));

      const result = await repo.delete(created.id);

      expect(result).toBe(true);
      await expect(repo.findById(created.id)).resolves.toBeNull();
      await expect(repo.listAll()).resolves.toEqual([]);
    });
  });

  describe("listAll", () => {
    it("returns an empty array for a fresh repository", async () => {
      await expect(repo.listAll()).resolves.toEqual([]);
    });

    it("returns every series in insertion order", async () => {
      const first = await repo.create(input(RRULE_V1));
      const second = await repo.create(input(RRULE_V2));

      await expect(repo.listAll()).resolves.toEqual([first, second]);
    });
  });
});
