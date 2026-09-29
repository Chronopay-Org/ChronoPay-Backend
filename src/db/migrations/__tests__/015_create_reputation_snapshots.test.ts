import { jest } from "@jest/globals";
import { migration } from "../015_create_reputation_snapshots.js";

type MockClient = {
  query: jest.Mock<(text: string, values?: unknown[]) => Promise<unknown>>;
};

function createMockClient(): MockClient {
  return {
    query: jest
      .fn<(text: string, values?: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({ rows: [], rowCount: 0 }),
  };
}

/** Pulls the raw SQL string out of each recorded query() call. */
function queriedSql(client: MockClient): string[] {
  return client.query.mock.calls.map((call) => String(call[0]));
}

describe("migration 015_create_reputation_snapshots", () => {
  describe("contract", () => {
    it("exposes the id/name/up/down shape required by the migration runner", () => {
      expect(migration.id).toBe("021");
      expect(migration.name).toBe("create_reputation_snapshots");
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });

    it("uses a non-empty, trimmed id and name", () => {
      expect(migration.id.trim()).not.toBe("");
      expect(migration.name.trim()).not.toBe("");
    });
  });

  describe("up()", () => {
    it("creates the reputation_snapshots table with all required columns", async () => {
      const client = createMockClient();

      await migration.up(client as any);

      const tableStatement = queriedSql(client).find((q) =>
        /CREATE TABLE reputation_snapshots/i.test(q),
      );
      expect(tableStatement).toBeDefined();

      // Primary key
      expect(tableStatement).toEqual(expect.stringContaining("id"));
      expect(tableStatement).toEqual(expect.stringContaining("UUID"));
      expect(tableStatement).toEqual(expect.stringContaining("PRIMARY KEY"));
      expect(tableStatement).toEqual(expect.stringContaining("gen_random_uuid()"));

      // Required columns
      expect(tableStatement).toEqual(expect.stringContaining("supplier_id"));
      expect(tableStatement).toEqual(expect.stringContaining("TEXT  NOT NULL"));
      expect(tableStatement).toEqual(expect.stringContaining("snapshot_date"));
      expect(tableStatement).toEqual(expect.stringContaining("DATE  NOT NULL"));
      expect(tableStatement).toEqual(expect.stringContaining("score"));
      expect(tableStatement).toEqual(expect.stringContaining("NUMERIC(10, 4) NOT NULL"));
      expect(tableStatement).toEqual(expect.stringContaining("tier_label"));
      expect(tableStatement).toEqual(expect.stringContaining("tier_boundaries"));
      expect(tableStatement).toEqual(expect.stringContaining("JSONB NOT NULL"));
      expect(tableStatement).toEqual(expect.stringContaining("job_run_id"));
      expect(tableStatement).toEqual(expect.stringContaining("created_at"));
      expect(tableStatement).toEqual(expect.stringContaining("TIMESTAMPTZ NOT NULL DEFAULT NOW()"));
    });

    it("creates the unique index on (supplier_id, snapshot_date) after the table", async () => {
      const client = createMockClient();

      await migration.up(client as any);

      const sql = queriedSql(client);
      const tableIdx = sql.findIndex((q) => /CREATE TABLE reputation_snapshots/i.test(q));
      const uniqueIdxIdx = sql.findIndex((q) =>
        /CREATE UNIQUE INDEX idx_reputation_snapshots_supplier_date/i.test(q),
      );

      expect(uniqueIdxIdx).toBeGreaterThan(tableIdx);
      expect(sql[uniqueIdxIdx]).toEqual(
        expect.stringContaining("ON reputation_snapshots (supplier_id, snapshot_date)"),
      );
    });

    it("creates the snapshot_date descending index for time-series queries after the table", async () => {
      const client = createMockClient();

      await migration.up(client as any);

      const sql = queriedSql(client);
      const tableIdx = sql.findIndex((q) => /CREATE TABLE reputation_snapshots/i.test(q));
      const dateIdxIdx = sql.findIndex((q) =>
        /CREATE INDEX idx_reputation_snapshots_date/i.test(q),
      );

      expect(dateIdxIdx).toBeGreaterThan(tableIdx);
      expect(sql[dateIdxIdx]).toEqual(
        expect.stringContaining("ON reputation_snapshots (snapshot_date DESC)"),
      );
    });

    it("issues exactly three statements in up() (table + two indexes)", async () => {
      const client = createMockClient();

      await migration.up(client as any);

      expect(client.query).toHaveBeenCalledTimes(3);
    });

    it("propagates and does not swallow a failure on the first statement", async () => {
      const client = createMockClient();
      const dbError = new Error("relation \"reputation_snapshots\" already exists");
      client.query.mockRejectedValueOnce(dbError);

      await expect(migration.up(client as any)).rejects.toThrow(dbError);
      // Stops immediately: only the failing statement was attempted.
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it("propagates a failure from the unique-index statement without issuing the date-index statement", async () => {
      const client = createMockClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE succeeds
        .mockRejectedValueOnce(new Error("index already exists")); // unique index fails

      await expect(migration.up(client as any)).rejects.toThrow("index already exists");
      // The date-range index must never have been issued.
      expect(client.query).toHaveBeenCalledTimes(2);
    });

    it("propagates a failure from the date-index statement", async () => {
      const client = createMockClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE succeeds
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // unique index succeeds
        .mockRejectedValueOnce(new Error("index idx_reputation_snapshots_date already exists"));

      await expect(migration.up(client as any)).rejects.toThrow(
        "index idx_reputation_snapshots_date already exists",
      );
      expect(client.query).toHaveBeenCalledTimes(3);
    });
  });

  describe("down()", () => {
    it("drops the reputation_snapshots table", async () => {
      const client = createMockClient();

      await migration.down(client as any);

      const sql = queriedSql(client);
      expect(sql.some((q) => /DROP TABLE IF EXISTS reputation_snapshots/i.test(q))).toBe(true);
    });

    it("uses IF EXISTS so re-running down() on an already-reverted schema is a no-op", async () => {
      const client = createMockClient();

      await migration.down(client as any);

      const sql = queriedSql(client);
      // The guard prevents errors when the table is already gone.
      expect(sql.some((q) => /DROP TABLE IF EXISTS/i.test(q))).toBe(true);
    });

    it("issues exactly one statement in down()", async () => {
      const client = createMockClient();

      await migration.down(client as any);

      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it("propagates a failure when dropping the table (e.g. dependent objects still reference it)", async () => {
      const client = createMockClient();
      const dbError = new Error(
        "cannot drop table reputation_snapshots because other objects depend on it",
      );
      client.query.mockRejectedValueOnce(dbError);

      await expect(migration.down(client as any)).rejects.toThrow(dbError);
      expect(client.query).toHaveBeenCalledTimes(1);
    });
  });
});
