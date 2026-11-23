import { jest } from "@jest/globals";
import { QueryResult } from "pg";
import { PgMaterializedOccurrenceRepository } from "../materializedOccurrenceRepository.js";
import { MaterializedOccurrence } from "../../models/materializedOccurrence.js";

describe("PgMaterializedOccurrenceRepository", () => {
  let repository: PgMaterializedOccurrenceRepository;
  let mockQuery: jest.Mock<(text: string, params?: unknown[]) => Promise<QueryResult>>;

  beforeEach(() => {
    mockQuery = jest.fn<(text: string, params?: unknown[]) => Promise<QueryResult>>();
    repository = new PgMaterializedOccurrenceRepository(mockQuery as any);
  });

  const baseTime = new Date("2026-01-01T00:00:00Z").getTime();

  const dbRow = {
    id: "occ-uuid-1",
    series_id: "series-uuid-1",
    series_version: 1,
    occurrence_date: new Date(baseTime + 3600000),
    materialized_at: new Date("2026-01-01T00:00:00Z"),
    created_at: new Date("2026-01-01T00:00:00Z"),
  };

  const expectedOccurrence: MaterializedOccurrence = {
    id: "occ-uuid-1",
    seriesId: "series-uuid-1",
    seriesVersion: 1,
    occurrenceDate: baseTime + 3600000,
    materializedAt: new Date("2026-01-01T00:00:00Z").getTime(),
    createdAt: new Date("2026-01-01T00:00:00Z").getTime(),
  };

  describe("findBySeriesId", () => {
    it("returns occurrences within date range for latest version", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [dbRow],
        rowCount: 1,
      } as any);

      const result = await repository.findBySeriesId(
        "series-uuid-1",
        baseTime,
        baseTime + 86400000,
      );

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DISTINCT ON (occurrence_date)"),
        ["series-uuid-1", new Date(baseTime), new Date(baseTime + 86400000)],
      );
      expect(result).toEqual([expectedOccurrence]);
    });

    it("returns empty array when no occurrences found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.findBySeriesId(
        "series-uuid-1",
        baseTime,
        baseTime + 86400000,
      );

      expect(result).toEqual([]);
    });
  });

  describe("cleanStaleVersions", () => {
    it("deletes occurrences with version older than current", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 5 } as any);

      const result = await repository.cleanStaleVersions("series-uuid-1", 3);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("series_version < $2"),
        ["series-uuid-1", 3],
      );
      expect(result).toBe(5);
    });
  });

  describe("cleanExpired", () => {
    it("deletes occurrences before the given cutoff", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 10 } as any);

      const result = await repository.cleanExpired(baseTime);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("occurrence_date < $1"),
        [new Date(baseTime)],
      );
      expect(result).toBe(10);
    });
  });

  describe("deleteBySeriesId", () => {
    it("deletes all occurrences for a series", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 4 } as any);

      const result = await repository.deleteBySeriesId("series-uuid-1");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM materialized_occurrences WHERE series_id = $1"),
        ["series-uuid-1"],
      );
      expect(result).toBe(4);
    });
  });
});
