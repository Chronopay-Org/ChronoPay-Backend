import { jest } from "@jest/globals";
import { QueryResult } from "pg";
import { PgRecurrenceSeriesRepository } from "../recurrenceSeriesRepository.js";
import { RecurrenceSeries } from "../../models/recurrenceSeries.js";

describe("PgRecurrenceSeriesRepository", () => {
  let repository: PgRecurrenceSeriesRepository;
  let mockQuery: jest.Mock<(text: string, params?: unknown[]) => Promise<QueryResult>>;

  beforeEach(() => {
    mockQuery = jest.fn<(text: string, params?: unknown[]) => Promise<QueryResult>>();
    repository = new PgRecurrenceSeriesRepository(mockQuery as any);
  });

  const dbRow = {
    id: "series-uuid-1",
    rrule: "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO",
    version: 1,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };

  const expectedSeries: RecurrenceSeries = {
    id: "series-uuid-1",
    rrule: "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO",
    version: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z").getTime(),
    updatedAt: new Date("2026-01-01T00:00:00.000Z").getTime(),
  };

  describe("create", () => {
    it("inserts a new series and returns the mapped record", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      const result = await repository.create({
        rrule: "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO",
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO recurrence_series"),
        ["DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO"],
      );
      expect(result).toEqual(expectedSeries);
    });
  });

  describe("findById", () => {
    it("returns the series if found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      const result = await repository.findById("series-uuid-1");

      expect(result).toEqual(expectedSeries);
    });

    it("returns null if not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.findById("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("updateRRule", () => {
    it("updates the RRULE and bumps version atomically", async () => {
      const updatedRow = { ...dbRow, rrule: "NEW_RRULE", version: 2 };
      mockQuery.mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as any);

      const result = await repository.updateRRule("series-uuid-1", "NEW_RRULE");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("version = version + 1"),
        ["series-uuid-1", "NEW_RRULE"],
      );
      expect(result?.version).toBe(2);
    });

    it("returns null if series not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.updateRRule("nonexistent", "RRULE");

      expect(result).toBeNull();
    });
  });

  describe("listAll", () => {
    it("returns all series ordered by created_at", async () => {
      const rows = [
        dbRow,
        { ...dbRow, id: "series-uuid-2", created_at: new Date("2026-01-02T00:00:00Z") },
      ];
      mockQuery.mockResolvedValueOnce({ rows } as any);

      const result = await repository.listAll();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("series-uuid-1");
    });
  });

  describe("delete", () => {
    it("deletes a series and returns true", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const result = await repository.delete("series-uuid-1");

      expect(result).toBe(true);
    });

    it("returns false if series not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.delete("nonexistent");

      expect(result).toBe(false);
    });
  });
});
