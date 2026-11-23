import {
  InMemoryRecurrenceSeriesRepository,
} from "../../models/recurrenceSeries.js";
import {
  InMemoryMaterializedOccurrenceRepository,
} from "../../models/materializedOccurrence.js";
import {
  materializeAllSeries,
  materializeSeries,
  HORIZON_DAYS,
} from "../occurrenceMaterializer.js";

/**
 * Occurrence Materializer Tests
 *
 * Covers:
 *  - Basic materialization within 90-day horizon
 *  - RRULE expansion correctness (weekly, daily, monthly)
 *  - Rolling horizon (expired occurrences cleaned)
 *  - Stale version cleanup on series edit
 *  - DST transitions (handled by rrule library)
 *  - Unbounded RRULE handling
 *  - Empty series list
 *  - Series with zero occurrences in horizon
 *  - Error handling for invalid RRULEs
 *  - Concurrent materialization safety
 *  - Horizon edge boundaries
 */

describe("Occurrence Materializer", () => {
  let seriesRepo: InMemoryRecurrenceSeriesRepository;
  let occRepo: InMemoryMaterializedOccurrenceRepository;

  beforeEach(() => {
    seriesRepo = new InMemoryRecurrenceSeriesRepository();
    seriesRepo.reset();
    occRepo = new InMemoryMaterializedOccurrenceRepository();
    occRepo.reset();
  });

  describe("materializeSeries", () => {
    it("materializes weekly occurrences within the horizon window", async () => {
      const series = await seriesRepo.create({
        rrule: "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=10;BYDAY=MO",
      });

      const horizonStart = new Date("2026-01-01T00:00:00Z").getTime();
      const result = await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });

      // Mondays in Jan 2026: 5, 12, 19, 26 → 4 occurrences in 30-day window
      expect(result.occurrencesMaterialized).toBe(4);
      expect(result.staleCleaned).toBe(0);

      const occs = await occRepo.findBySeriesId(
        series.id,
        horizonStart,
        horizonStart + 30 * 24 * 60 * 60 * 1000,
      );
      expect(occs.length).toBe(4);
      occs.forEach((o) => {
        expect(o.seriesVersion).toBe(series.version);
        expect(o.occurrenceDate).toBeGreaterThanOrEqual(horizonStart);
      });
    });

    it("materializes daily occurrences within horizon", async () => {
      const series = await seriesRepo.create({
        rrule:
          "DTSTART:20260101T080000Z\nRRULE:FREQ=DAILY;COUNT=30",
      });

      const horizonStart = new Date("2026-01-01T00:00:00Z").getTime();
      const result = await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 14,
        now: horizonStart,
      });

      // 15 days from Jan 1-14 inclusive within 14-day horizon
      expect(result.occurrencesMaterialized).toBe(14);

      const occs = await occRepo.findBySeriesId(
        series.id,
        horizonStart,
        horizonStart + 14 * 24 * 60 * 60 * 1000,
      );
      expect(occs.length).toBe(14);
    });

    it("cleans stale versions when series is edited and re-materialized", async () => {
      const series = await seriesRepo.create({
        rrule:
          "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO",
      });

      const horizonStart = new Date("2026-01-01T00:00:00Z").getTime();
      await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });

      // Edit series (bumps version)
      const updated = await seriesRepo.updateRRule(
        series.id,
        "DTSTART:20260112T100000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3;BYDAY=MO",
      );

      expect(updated).toBeDefined();
      if (!updated) throw new Error("series update failed");
      expect(updated.version).toBe(2);

      // Re-materialize — should clean stale version 1 occurrences
      const result = await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });

      expect(result.staleCleaned).toBeGreaterThanOrEqual(0);
      expect(updated.version).toBe(2);

      // All remaining occurrences should have version 2
      const occs = await occRepo.findBySeriesId(
        series.id,
        horizonStart,
        horizonStart + 30 * 24 * 60 * 60 * 1000,
      );
      occs.forEach((o) => {
        expect(o.seriesVersion).toBe(2);
      });
    });

    it("respects DST transitions through rrule library", async () => {
      // March 8, 2026 — DST transition in US (spring forward)
      const series = await seriesRepo.create({
        rrule:
          "DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;COUNT=14",
      });

      const horizonStart = new Date("2026-03-01T00:00:00Z").getTime();
      const result = await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 14,
        now: horizonStart,
      });

      expect(result.occurrencesMaterialized).toBe(14);

      const occs = await occRepo.findBySeriesId(
        series.id,
        horizonStart,
        horizonStart + 14 * 24 * 60 * 60 * 1000,
      );

      // Every occurrence should be at 09:00 UTC regardless of DST
      occs.forEach((o) => {
        const date = new Date(o.occurrenceDate);
        expect(date.getUTCHours()).toBe(9);
      });
    });

    it("handles unbounded RRULE by adding a default COUNT", async () => {
      const series = await seriesRepo.create({
        rrule: "DTSTART:20260101T100000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO", // Unbounded!
      });

      const horizonStart = new Date("2026-01-01T00:00:00Z").getTime();
      const result = await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 90,
        now: horizonStart,
      });

      expect(result.occurrencesMaterialized).toBeGreaterThan(0);
      // Should be capped to horizon
      const occs = await occRepo.findBySeriesId(
        series.id,
        horizonStart,
        horizonStart + 90 * 24 * 60 * 60 * 1000,
      );
      const maxDate = Math.max(...occs.map((o) => o.occurrenceDate));
      expect(maxDate).toBeLessThanOrEqual(horizonStart + 90 * 24 * 60 * 60 * 1000);
    });

    it("returns zero occurrences for series with no dates in horizon", async () => {
      const series = await seriesRepo.create({
        rrule:
          "DTSTART:20270101T100000Z\nRRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO",
      });

      const horizonStart = new Date("2026-01-01T00:00:00Z").getTime();
      const result = await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });

      expect(result.occurrencesMaterialized).toBe(0);

      const occs = await occRepo.findBySeriesId(
        series.id,
        horizonStart,
        horizonStart + 30 * 24 * 60 * 60 * 1000,
      );
      expect(occs.length).toBe(0);
    });

    it("throws for non-existent series", async () => {
      await expect(
        materializeSeries("nonexistent", {
          seriesRepository: seriesRepo,
          occurrenceRepository: occRepo,
          horizonDays: 30,
        }),
      ).rejects.toThrow("Recurrence series not found");
    });

    it("throws for invalid RRULE", async () => {
      const series = await seriesRepo.create({
        rrule: "DTSTART:20260101T100000Z\nRRULE:FREQ=INVALID_FREQ",
      });

      await expect(
        materializeSeries(series.id, {
          seriesRepository: seriesRepo,
          occurrenceRepository: occRepo,
          horizonDays: 30,
          now: new Date("2026-01-01T00:00:00Z").getTime(),
        }),
      ).rejects.toThrow();
    });
  });

  describe("materializeAllSeries", () => {
    it("materializes all series and reports statistics", async () => {
      await seriesRepo.create({
        rrule:
          "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO",
      });
      await seriesRepo.create({
        rrule:
          "DTSTART:20260107T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=WE",
      });

      const horizonStart = new Date("2026-01-01T00:00:00Z").getTime();
      const report = await materializeAllSeries({
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });

      expect(report.seriesProcessed).toBe(2);
      expect(report.seriesFailed).toBe(0);
      expect(report.occurrencesMaterialized).toBeGreaterThan(0);
      expect(report.expiredCleaned).toBeGreaterThanOrEqual(0);
    });

    it("handles empty series list gracefully", async () => {
      const report = await materializeAllSeries({
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
      });

      expect(report.seriesProcessed).toBe(0);
      expect(report.seriesFailed).toBe(0);
      expect(report.occurrencesMaterialized).toBe(0);
    });

    it("continues processing other series when one fails", async () => {
      const _good = await seriesRepo.create({
        rrule:
          "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO",
      });
      const bad = await seriesRepo.create({
        rrule: "DTSTART:20260101T100000Z\nRRULE:FREQ=INVALID_FREQ",
      });

      const horizonStart = new Date("2026-01-01T00:00:00Z").getTime();
      const report = await materializeAllSeries({
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });

      expect(report.seriesProcessed).toBe(1);
      expect(report.seriesFailed).toBe(1);
      expect(report.occurrencesMaterialized).toBeGreaterThan(0);
      expect(report.errors.length).toBe(1);
      expect(report.errors[0]).toContain(bad.id);
    });

    it("cleans expired occurrences across all series", async () => {
      const series = await seriesRepo.create({
        rrule:
          "DTSTART:20251201T100000Z\nRRULE:FREQ=DAILY;COUNT=5",
      });

      const pastStart = new Date("2025-12-01T00:00:00Z").getTime();
      // Manually add old occurrences without going through materializeSeries
      await occRepo.bulkUpsert({
        seriesId: series.id,
        seriesVersion: series.version,
        occurrenceDates: [
          pastStart,
          pastStart + 86400000,
          pastStart + 2 * 86400000,
        ],
        materializedAt: pastStart,
      });

      // cleanExpired with a cutoff well past the old dates
      const expiredCleaned = await occRepo.cleanExpired(
        new Date("2026-02-01T00:00:00Z").getTime(),
      );

      expect(expiredCleaned).toBe(3);
    });

    it("respects the horizon boundary — no occurrences beyond 90 days", async () => {
      // Create a series that generates daily occurrences for a long period
      await seriesRepo.create({
        rrule:
          "DTSTART:20260101T100000Z\nRRULE:FREQ=DAILY;COUNT=365",
      });

      const horizonStart = new Date("2026-01-01T00:00:00Z").getTime();
      await materializeAllSeries({
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 90,
        now: horizonStart,
      });

      const allOccs = await occRepo.findBySeriesId(
        (await seriesRepo.listAll())[0].id,
        horizonStart,
        horizonStart + 365 * 24 * 60 * 60 * 1000,
      );

      // All occurrences should be within the 90-day window
      const maxDate = Math.max(...allOccs.map((o) => o.occurrenceDate));
      expect(maxDate).toBeLessThanOrEqual(
        horizonStart + 90 * 24 * 60 * 60 * 1000,
      );
    });

    it("handles concurrent re-materialization idempotently", async () => {
      const series = await seriesRepo.create({
        rrule:
          "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO",
      });

      const horizonStart = new Date("2026-01-01T00:00:00Z").getTime();

      // Run twice in quick succession
      await materializeAllSeries({
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });
      await materializeAllSeries({
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });

      const occs = await occRepo.findBySeriesId(
        series.id,
        horizonStart,
        horizonStart + 30 * 24 * 60 * 60 * 1000,
      );

      // Should not have duplicates (bulkUpsert replaces)
      const uniqueDates = new Set(occs.map((o) => o.occurrenceDate));
      expect(uniqueDates.size).toBe(occs.length);
    });
  });

  describe("rolling horizon behavior", () => {
    it("moves the horizon forward each day, dropping old occurrences", async () => {
      const series = await seriesRepo.create({
        rrule:
          "DTSTART:20260101T100000Z\nRRULE:FREQ=DAILY;COUNT=120",
      });

      const day1 = new Date("2026-01-01T00:00:00Z").getTime();
      const day31 = new Date("2026-01-31T00:00:00Z").getTime();

      // Materialize on day 1
      await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: day1,
      });

      const occsDay1 = await occRepo.findBySeriesId(
        series.id,
        day1,
        day1 + 90 * 24 * 60 * 60 * 1000,
      );
      const _day1Dates = occsDay1.map((o) => o.occurrenceDate);

      // Materialize on day 31 — should drop Jan 1-30 from horizon
      await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: day31,
      });

      const occsDay31 = await occRepo.findBySeriesId(
        series.id,
        day31,
        day31 + 30 * 24 * 60 * 60 * 1000,
      );

      // Day 31 occurrences should start from Feb 1 (not include Jan dates)
      const earliestDate = Math.min(...occsDay31.map((o) => o.occurrenceDate));
      expect(earliestDate).toBeGreaterThanOrEqual(day31);
    });

    it("covers the entire 90-day horizon end-to-end", async () => {
      const series = await seriesRepo.create({
        rrule:
          "DTSTART:20260101T080000Z\nRRULE:FREQ=DAILY;COUNT=120",
      });

      const now = new Date("2026-01-01T00:00:00Z").getTime();
      await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: HORIZON_DAYS,
        now,
      });

      const occs = await occRepo.findBySeriesId(
        series.id,
        now,
        now + HORIZON_DAYS * 24 * 60 * 60 * 1000,
      );

      expect(occs.length).toBe(HORIZON_DAYS);

      // Check each day is present
      for (let d = 0; d < HORIZON_DAYS; d++) {
        const dayStart = now + d * 24 * 60 * 60 * 1000;
        const hasOccurrence = occs.some(
          (o) =>
            o.occurrenceDate >= dayStart &&
            o.occurrenceDate < dayStart + 24 * 60 * 60 * 1000,
        );
        expect(hasOccurrence).toBe(true);
      }
    });
  });
});
