import { jest } from "@jest/globals";
import { QueryResult } from "pg";
import {
  PgRecurrenceSeriesRepository,
  getRecurrenceSeriesRepository,
  setRecurrenceSeriesRepositoryForTests,
} from "../recurrenceSeriesRepository.js";
import {
  RecurrenceSeries,
  type RecurrenceSeriesRepository,
} from "../../models/recurrenceSeries.js";

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

    it("treats a null rowCount as a no-op delete", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: null } as any);

      const result = await repository.delete("series-uuid-1");

      expect(result).toBe(false);
    });
  });

  describe("mapRow coercion", () => {
    it("coerces a string version and Date timestamps into the numeric model", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "series-uuid-7",
            rrule: "RRULE:FREQ=DAILY",
            version: "3",
            created_at: new Date("2026-03-01T00:00:00.000Z"),
            updated_at: "2026-03-02T00:00:00.000Z",
          },
        ],
      } as any);

      const result = await repository.findById("series-uuid-7");

      expect(result).toEqual({
        id: "series-uuid-7",
        rrule: "RRULE:FREQ=DAILY",
        version: 3,
        createdAt: new Date("2026-03-01T00:00:00.000Z").getTime(),
        updatedAt: new Date("2026-03-02T00:00:00.000Z").getTime(),
      });
      expect(typeof result?.version).toBe("number");
      expect(typeof result?.createdAt).toBe("number");
      expect(typeof result?.updatedAt).toBe("number");
    });

    it("maps every row returned by listAll and preserves database order", async () => {
      const earlier = { ...dbRow, id: "series-uuid-1" };
      const later = {
        ...dbRow,
        id: "series-uuid-2",
        version: "9",
        created_at: "2026-02-01T00:00:00.000Z",
        updated_at: "2026-02-02T00:00:00.000Z",
      };
      mockQuery.mockResolvedValueOnce({ rows: [earlier, later] } as any);

      const result = await repository.listAll();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY created_at ASC"),
      );
      expect(result).toEqual([
        expectedSeries,
        {
          id: "series-uuid-2",
          rrule: dbRow.rrule,
          version: 9,
          createdAt: new Date("2026-02-01T00:00:00.000Z").getTime(),
          updatedAt: new Date("2026-02-02T00:00:00.000Z").getTime(),
        },
      ]);
    });

    it("returns an empty array when there are no rows", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any);

      expect(await repository.listAll()).toEqual([]);
    });
  });

  describe("SQL parameter binding", () => {
    it("looks a series up by id with the id bound as a parameter", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await repository.findById("series-uuid-1");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM recurrence_series WHERE id = $1"),
        ["series-uuid-1"],
      );
    });

    it("binds the id when deleting", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await repository.delete("series-uuid-1");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM recurrence_series WHERE id = $1"),
        ["series-uuid-1"],
      );
    });
  });

  describe("module seam (getRecurrenceSeriesRepository / setRecurrenceSeriesRepositoryForTests)", () => {
    afterEach(() => {
      setRecurrenceSeriesRepositoryForTests(null);
    });

    const makeFake = (
      overrides: Partial<RecurrenceSeriesRepository> = {},
    ): { repo: RecurrenceSeriesRepository; createCalls: () => number } => {
      let createCalls = 0;
      const repo: RecurrenceSeriesRepository = {
        async create(input) {
          createCalls += 1;
          return {
            id: `fake-${createCalls}`,
            rrule: input.rrule,
            version: 1,
            createdAt: 1,
            updatedAt: 1,
          };
        },
        async findById() {
          return null;
        },
        async updateRRule() {
          return null;
        },
        async listAll() {
          return [];
        },
        async delete() {
          return false;
        },
        ...overrides,
      };
      return { repo, createCalls: () => createCalls };
    };

    it("lazily creates and then reuses a PgRecurrenceSeriesRepository singleton", () => {
      setRecurrenceSeriesRepositoryForTests(null);

      const first = getRecurrenceSeriesRepository();
      const second = getRecurrenceSeriesRepository();

      expect(first).toBe(second);
      expect(first).toBeInstanceOf(PgRecurrenceSeriesRepository);
    });

    it("returns an injected repository until the override is cleared", () => {
      const { repo: fake } = makeFake();

      setRecurrenceSeriesRepositoryForTests(fake);
      expect(getRecurrenceSeriesRepository()).toBe(fake);

      setRecurrenceSeriesRepositoryForTests(null);
      const restored = getRecurrenceSeriesRepository();
      expect(restored).not.toBe(fake);
      expect(restored).toBeInstanceOf(PgRecurrenceSeriesRepository);
    });

    it("routes calls made through the getter to the injected repository", async () => {
      const { repo: fake, createCalls } = makeFake();

      setRecurrenceSeriesRepositoryForTests(fake);
      const created = await getRecurrenceSeriesRepository().create({
        rrule: "RRULE:FREQ=DAILY",
      });

      expect(createCalls()).toBe(1);
      expect(created.rrule).toBe("RRULE:FREQ=DAILY");
    });
  });
});
