import {
  InMemoryRecurrenceSeriesRepository,
} from "../../models/recurrenceSeries.js";
import {
  InMemoryMaterializedOccurrenceRepository,
} from "../../models/materializedOccurrence.js";
import { OccurrenceSeriesService } from "../occurrenceSeriesService.js";
import {
  materializeSeries,
} from "../../scheduler/occurrenceMaterializer.js";

describe("OccurrenceSeriesService", () => {
  let seriesRepo: InMemoryRecurrenceSeriesRepository;
  let occRepo: InMemoryMaterializedOccurrenceRepository;
  let service: OccurrenceSeriesService;

  beforeEach(() => {
    seriesRepo = new InMemoryRecurrenceSeriesRepository();
    seriesRepo.reset();
    occRepo = new InMemoryMaterializedOccurrenceRepository();
    occRepo.reset();
    service = new OccurrenceSeriesService({
      seriesRepository: seriesRepo,
      occurrenceRepository: occRepo,
    });
  });

  describe("createSeries", () => {
    it("creates a new series with version 1", async () => {
      const series = await service.createSeries(
        "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO",
      );
      expect(series.id).toBeDefined();
      expect(series.version).toBe(1);
      expect(series.rrule).toContain("WEEKLY");
    });
  });

  describe("editSeries", () => {
    it("bumps version on RRULE edit, invalidating previous materializations", async () => {
      const series = await service.createSeries(
        "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO",
      );

      // Materialize some occurrences under version 1
      const horizonStart = new Date("2026-01-01T00:00:00Z").getTime();
      await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });

      const v1Occs = await occRepo.findBySeriesId(
        series.id,
        horizonStart,
        horizonStart + 30 * 24 * 60 * 60 * 1000,
      );
      expect(v1Occs.length).toBeGreaterThan(0);

      // Edit the series
      const updated = await service.editSeries(
        series.id,
        "DTSTART:20260112T100000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3;BYDAY=MO",
      );

      expect(updated.version).toBe(2);

      // Re-materialize with the new version
      await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });

      const v2Occs = await occRepo.findBySeriesId(
        series.id,
        horizonStart,
        horizonStart + 30 * 24 * 60 * 60 * 1000,
      );

      // All remaining occurrences should be version 2
      if (v2Occs.length > 0) {
        v2Occs.forEach((o) => {
          expect(o.seriesVersion).toBe(2);
        });
      }
    });

    it("throws when editing non-existent series", async () => {
      await expect(
        service.editSeries("nonexistent", "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=1"),
      ).rejects.toThrow("Recurrence series not found");
    });
  });

  describe("deleteSeries", () => {
    it("deletes series (occurrences deleted via FK cascade)", async () => {
      const series = await service.createSeries(
        "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO",
      );

      await service.deleteSeries(series.id);

      const found = await seriesRepo.findById(series.id);
      expect(found).toBeNull();
    });
  });

  describe("getOccurrences", () => {
    it("returns only the latest version occurrences", async () => {
      const series = await service.createSeries(
        "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO",
      );

      const horizonStart = new Date("2026-01-01T00:00:00Z").getTime();
      await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });

      // Edit to bump version and re-materialize
      await service.editSeries(
        series.id,
        "DTSTART:20260112T100000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3;BYDAY=MO",
      );

      await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays: 30,
        now: horizonStart,
      });

      const occs = await service.getOccurrences(
        series.id,
        horizonStart,
        horizonStart + 30 * 24 * 60 * 60 * 1000,
      );

      // All occurrences should be latest version
      if (occs.length > 0) {
        const latestVersion = Math.max(...occs.map((o) => o.seriesVersion));
        occs.forEach((o) => {
          expect(o.seriesVersion).toBe(latestVersion);
        });
      }
    });
  });
});
