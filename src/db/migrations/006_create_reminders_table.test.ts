import { jest } from "@jest/globals";
import { migration } from "../006_create_reminders_table.js";

type MockClient = {
  query: jest.Mock<(text: string, values?: unknown[]) => Promise<unknown>>;
};

function createMockClient(): MockClient {
  return {
    query: jest.fn<(text: string, values?: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({ rows: [], rowCount: 0 }),
  };
}

/** Pulls the raw SQL string out of each recorded query() call. */
function queriedSql(client: MockClient): string[] {
  return client.query.mock.calls.map((call) => String(call[0]));
}

describe("migration 006_create_reminders_table", () => {
  describe("contract", () => {
    it("exposes the id/name/up/down shape required by the migration runner", () => {
      expect(migration.id).toBe("006");
      expect(migration.name).toBe("create_reminders_table");
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });

    it("uses a non-empty, trimmed id and name (rejects the empty-field checks in MigrationRunner.validate)", () => {
      expect(migration.id.trim()).not.toBe("");
      expect(migration.name.trim()).not.toBe("");
    });
  });

  describe("up()", () => {
    it("creates the reminder_status enum before the reminders table (state transition ordering)", async () => {
      const client = createMockClient();

      await migration.up(client as any);

      const sql = queriedSql(client);
      const enumIdx = sql.findIndex((q) => /CREATE TYPE reminder_status/i.test(q));
      const tableIdx = sql.findIndex((q) => /CREATE TABLE reminders/i.test(q));

      expect(enumIdx).toBeGreaterThanOrEqual(0);
      expect(tableIdx).toBeGreaterThan(enumIdx);
    });

    it("defines the enum with exactly the pending/sent/failed values", async () => {
      const client = createMockClient();

      await migration.up(client as any);

      const enumStatement = queriedSql(client).find((q) =>
        /CREATE TYPE reminder_status/i.test(q),
      );
      expect(enumStatement).toBeDefined();
      expect(enumStatement).toEqual(
        expect.stringContaining("'pending', 'sent', 'failed'"),
      );
    });

    it("creates the reminders table with the required columns, defaults, and constraints", async () => {
      const client = createMockClient();

      await migration.up(client as any);

      const tableStatement = queriedSql(client).find((q) =>
        /CREATE TABLE reminders/i.test(q),
      );
      expect(tableStatement).toBeDefined();

      // Primary key / required columns
      expect(tableStatement).toEqual(expect.stringContaining("id              UUID"));
      expect(tableStatement).toEqual(expect.stringContaining("PRIMARY KEY"));
      expect(tableStatement).toEqual(
        expect.stringContaining("slot_id         INTEGER          NOT NULL"),
      );
      expect(tableStatement).toEqual(
        expect.stringContaining("trigger_at      TIMESTAMPTZ      NOT NULL"),
      );
      expect(tableStatement).toEqual(
        expect.stringContaining("status          reminder_status   NOT NULL DEFAULT 'pending'"),
      );
      expect(tableStatement).toEqual(
        expect.stringContaining("attempts        INTEGER          NOT NULL DEFAULT 0"),
      );

      // Boundary/invariant: attempts can never go negative
      expect(tableStatement).toEqual(
        expect.stringContaining(
          "CONSTRAINT chk_reminders_attempts_non_negative CHECK (attempts >= 0)",
        ),
      );
    });

    it("creates the status/trigger_at and slot_id indexes after the table exists", async () => {
      const client = createMockClient();

      await migration.up(client as any);

      const sql = queriedSql(client);
      const tableIdx = sql.findIndex((q) => /CREATE TABLE reminders/i.test(q));
      const statusIdxIdx = sql.findIndex((q) =>
        /CREATE INDEX idx_reminders_status_trigger_at/i.test(q),
      );
      const slotIdxIdx = sql.findIndex((q) => /CREATE INDEX idx_reminders_slot_id/i.test(q));

      expect(statusIdxIdx).toBeGreaterThan(tableIdx);
      expect(slotIdxIdx).toBeGreaterThan(tableIdx);
      expect(sql[statusIdxIdx]).toEqual(
        expect.stringContaining("ON reminders (status, trigger_at)"),
      );
      expect(sql[slotIdxIdx]).toEqual(expect.stringContaining("ON reminders (slot_id)"));
    });

    it("issues exactly four statements in up() (enum, table, two indexes)", async () => {
      const client = createMockClient();

      await migration.up(client as any);

      expect(client.query).toHaveBeenCalledTimes(4);
    });

    it("propagates and does not swallow a failure on the first statement (invalid/broken client)", async () => {
      const client = createMockClient();
      const dbError = new Error("relation \"reminder_status\" already exists");
      client.query.mockRejectedValueOnce(dbError);

      await expect(migration.up(client as any)).rejects.toThrow(dbError);
      // Stops immediately: only the failing statement was attempted.
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it("propagates a failure from a later statement without continuing to the remaining ones", async () => {
      const client = createMockClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TYPE succeeds
        .mockRejectedValueOnce(new Error("duplicate table reminders")); // CREATE TABLE fails

      await expect(migration.up(client as any)).rejects.toThrow("duplicate table reminders");
      // The two CREATE INDEX statements must never have been issued.
      expect(client.query).toHaveBeenCalledTimes(2);
    });
  });

  describe("down()", () => {
    it("drops the table before the enum type it depends on (reverse state transition ordering)", async () => {
      const client = createMockClient();

      await migration.down(client as any);

      const sql = queriedSql(client);
      const tableDropIdx = sql.findIndex((q) => /DROP TABLE IF EXISTS reminders/i.test(q));
      const typeDropIdx = sql.findIndex((q) => /DROP TYPE IF EXISTS reminder_status/i.test(q));

      expect(tableDropIdx).toBeGreaterThanOrEqual(0);
      expect(typeDropIdx).toBeGreaterThan(tableDropIdx);
    });

    it("uses IF EXISTS guards so re-running down() on an already-reverted schema is a no-op, not an error", async () => {
      const client = createMockClient();

      await migration.down(client as any);

      const sql = queriedSql(client);
      expect(sql.some((q) => /DROP TABLE IF EXISTS reminders/i.test(q))).toBe(true);
      expect(sql.some((q) => /DROP TYPE IF EXISTS reminder_status/i.test(q))).toBe(true);
    });

    it("issues exactly two statements in down()", async () => {
      const client = createMockClient();

      await migration.down(client as any);

      expect(client.query).toHaveBeenCalledTimes(2);
    });

    it("propagates a failure when dropping the table (e.g. dependent objects still reference it)", async () => {
      const client = createMockClient();
      const dbError = new Error("cannot drop table reminders because other objects depend on it");
      client.query.mockRejectedValueOnce(dbError);

      await expect(migration.down(client as any)).rejects.toThrow(dbError);
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it("propagates a failure when dropping the enum type without silently succeeding", async () => {
      const client = createMockClient();
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // DROP TABLE succeeds
        .mockRejectedValueOnce(new Error("type reminder_status does not exist"));

      await expect(migration.down(client as any)).rejects.toThrow(
        "type reminder_status does not exist",
      );
      expect(client.query).toHaveBeenCalledTimes(2);
    });
  });
});
