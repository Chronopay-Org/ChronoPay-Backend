import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { migration } from "../migrations/011_add_slot_valid_until.js";
import { PoolClient } from "pg";

describe("011_add_slot_valid_until migration", () => {
  let mockClient: Partial<PoolClient>;
  let mockQuery: jest.Mock;

  beforeEach(() => {
    mockQuery = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] } as never);
    mockClient = {
      query: mockQuery as unknown as PoolClient["query"],
    };
  });

  describe("contract and metadata", () => {
    it("exposes the expected migration metadata", () => {
      expect(migration).toBeDefined();
      expect(migration.id).toBe("013");
      expect(migration.name).toBe("add_slot_valid_until");
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });
  });

  describe("up migration", () => {
    it("executes add column, add constraint, and create index queries on valid client", async () => {
      await migration.up(mockClient as PoolClient);

      expect(mockQuery).toHaveBeenCalledTimes(3);

      const addColumnQuery = mockQuery.mock.calls[0][0] as string;
      expect(addColumnQuery).toContain("ALTER TABLE slots");
      expect(addColumnQuery).toContain("ADD COLUMN valid_until TIMESTAMPTZ");

      const addConstraintQuery = mockQuery.mock.calls[1][0] as string;
      expect(addConstraintQuery).toContain("ALTER TABLE slots");
      expect(addConstraintQuery).toContain("ADD CONSTRAINT chk_slots_valid_until_after_end");
      expect(addConstraintQuery).toContain("CHECK (valid_until IS NULL OR valid_until > end_time)");

      const createIndexQuery = mockQuery.mock.calls[2][0] as string;
      expect(createIndexQuery).toContain("CREATE INDEX idx_slots_valid_until");
      expect(createIndexQuery).toContain("ON slots (valid_until)");
      expect(createIndexQuery).toContain("WHERE valid_until IS NOT NULL");
    });

    it("propagates database errors when adding column fails", async () => {
      const dbError = new Error("DB connection failed");
      mockQuery.mockRejectedValueOnce(dbError);

      await expect(migration.up(mockClient as PoolClient)).rejects.toThrow("DB connection failed");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("propagates database errors when adding constraint fails", async () => {
      const dbError = new Error("Constraint creation failed");
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockRejectedValueOnce(dbError);

      await expect(migration.up(mockClient as PoolClient)).rejects.toThrow(
        "Constraint creation failed",
      );
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it("propagates database errors when creating index fails", async () => {
      const dbError = new Error("Index creation failed");
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockRejectedValueOnce(dbError);

      await expect(migration.up(mockClient as PoolClient)).rejects.toThrow("Index creation failed");
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it("throws TypeError when client or query method is missing", async () => {
      await expect(migration.up(null as unknown as PoolClient)).rejects.toThrow();
      await expect(migration.up(undefined as unknown as PoolClient)).rejects.toThrow();
      await expect(migration.up({} as PoolClient)).rejects.toThrow();
      await expect(
        migration.up({ query: "not a function" } as unknown as PoolClient),
      ).rejects.toThrow();
    });
  });

  describe("down migration", () => {
    it("executes drop index, drop constraint, and drop column queries in correct order on valid client", async () => {
      await migration.down(mockClient as PoolClient);

      expect(mockQuery).toHaveBeenCalledTimes(3);

      const dropIndexQuery = mockQuery.mock.calls[0][0] as string;
      expect(dropIndexQuery).toContain("DROP INDEX IF EXISTS idx_slots_valid_until");

      const dropConstraintQuery = mockQuery.mock.calls[1][0] as string;
      expect(dropConstraintQuery).toContain(
        "ALTER TABLE slots DROP CONSTRAINT IF EXISTS chk_slots_valid_until_after_end",
      );

      const dropColumnQuery = mockQuery.mock.calls[2][0] as string;
      expect(dropColumnQuery).toContain("ALTER TABLE slots DROP COLUMN IF EXISTS valid_until");
    });

    it("propagates database errors when dropping index fails", async () => {
      const dbError = new Error("Drop index failed");
      mockQuery.mockRejectedValueOnce(dbError);

      await expect(migration.down(mockClient as PoolClient)).rejects.toThrow("Drop index failed");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("propagates database errors when dropping constraint fails", async () => {
      const dbError = new Error("Drop constraint failed");
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockRejectedValueOnce(dbError);

      await expect(migration.down(mockClient as PoolClient)).rejects.toThrow(
        "Drop constraint failed",
      );
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it("propagates database errors when dropping column fails", async () => {
      const dbError = new Error("Drop column failed");
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockRejectedValueOnce(dbError);

      await expect(migration.down(mockClient as PoolClient)).rejects.toThrow("Drop column failed");
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it("throws TypeError when client or query method is missing", async () => {
      await expect(migration.down(null as unknown as PoolClient)).rejects.toThrow();
      await expect(migration.down(undefined as unknown as PoolClient)).rejects.toThrow();
      await expect(migration.down({} as PoolClient)).rejects.toThrow();
      await expect(
        migration.down({ query: "not a function" } as unknown as PoolClient),
      ).rejects.toThrow();
    });
  });
});
