import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { migration } from "../migrations/007_add_supplier_kyc_columns.js";
import { PoolClient } from "pg";

describe("007_add_supplier_kyc_columns migration", () => {
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
      expect(migration.id).toBe("007");
      expect(migration.name).toBe("add_supplier_kyc_columns");
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });
  });

  describe("up migration", () => {
    it("executes create enum type and alter table queries on valid client", async () => {
      await migration.up(mockClient as PoolClient);

      expect(mockQuery).toHaveBeenCalledTimes(2);

      const createTypeQuery = mockQuery.mock.calls[0][0] as string;
      expect(createTypeQuery).toContain("CREATE TYPE kyc_status_type AS ENUM");
      expect(createTypeQuery).toContain("'pending', 'verified', 'rejected', 'under_review'");

      const alterTableQuery = mockQuery.mock.calls[1][0] as string;
      expect(alterTableQuery).toContain("ALTER TABLE users");
      expect(alterTableQuery).toContain("ADD COLUMN kyc_status kyc_status_type NOT NULL DEFAULT 'pending'");
      expect(alterTableQuery).toContain("ADD COLUMN kyc_ref VARCHAR(255)");
    });

    it("propagates database errors when creating enum type fails", async () => {
      const dbError = new Error("DB type creation failed");
      mockQuery.mockRejectedValueOnce(dbError);

      await expect(migration.up(mockClient as PoolClient)).rejects.toThrow("DB type creation failed");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("propagates database errors when altering table fails", async () => {
      const dbError = new Error("Alter table failed");
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockRejectedValueOnce(dbError);

      await expect(migration.up(mockClient as PoolClient)).rejects.toThrow("Alter table failed");
      expect(mockQuery).toHaveBeenCalledTimes(2);
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
    it("executes drop columns and drop type queries in correct order on valid client", async () => {
      await migration.down(mockClient as PoolClient);

      expect(mockQuery).toHaveBeenCalledTimes(2);

      const dropColumnsQuery = mockQuery.mock.calls[0][0] as string;
      expect(dropColumnsQuery).toContain("ALTER TABLE users");
      expect(dropColumnsQuery).toContain("DROP COLUMN IF EXISTS kyc_status");
      expect(dropColumnsQuery).toContain("DROP COLUMN IF EXISTS kyc_ref");

      const dropTypeQuery = mockQuery.mock.calls[1][0] as string;
      expect(dropTypeQuery).toContain("DROP TYPE IF EXISTS kyc_status_type");
    });

    it("propagates database errors when dropping columns fails", async () => {
      const dbError = new Error("Drop columns failed");
      mockQuery.mockRejectedValueOnce(dbError);

      await expect(migration.down(mockClient as PoolClient)).rejects.toThrow("Drop columns failed");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it("propagates database errors when dropping type fails", async () => {
      const dbError = new Error("Drop type failed");
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockRejectedValueOnce(dbError);

      await expect(migration.down(mockClient as PoolClient)).rejects.toThrow("Drop type failed");
      expect(mockQuery).toHaveBeenCalledTimes(2);
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
