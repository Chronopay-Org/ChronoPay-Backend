import { jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../016_create_holiday_calendars.js";

type Query = (text: string) => Promise<unknown>;

function mockClient(): { client: PoolClient; query: jest.MockedFunction<Query> } {
  const query = jest.fn<Query>();
  return { client: { query } as unknown as PoolClient, query };
}

function normalizedQuery(query: jest.MockedFunction<Query>, index: number): string {
  return query.mock.calls[index]?.[0].replace(/\s+/g, " ").trim() ?? "";
}

describe("migration 016 create_holiday_calendars", () => {
  it("exposes the expected migration identity", () => {
    expect(migration.id).toBe("016");
    expect(migration.name).toBe("create_holiday_calendars");
  });

  it("creates calendar, entry, and revision tables in dependency order", async () => {
    const { client, query } = mockClient();

    await migration.up(client);

    expect(query).toHaveBeenCalledTimes(6);
    expect(normalizedQuery(query, 0)).toContain("CREATE TABLE holiday_calendars");
    expect(normalizedQuery(query, 1)).toContain(
      "CREATE TABLE holiday_calendar_entries",
    );
    expect(normalizedQuery(query, 2)).toContain(
      "CREATE INDEX idx_holiday_entries_calendar_id",
    );
    expect(normalizedQuery(query, 4)).toContain(
      "CREATE TABLE holiday_calendar_revisions",
    );
    expect(normalizedQuery(query, 5)).toContain(
      "CREATE INDEX idx_holiday_revisions_calendar_id",
    );
  });

  it("encodes invalid-value and relationship boundaries in constraints", async () => {
    const { client, query } = mockClient();

    await migration.up(client);

    const calendars = normalizedQuery(query, 0);
    expect(calendars).toContain("UNIQUE (region)");

    const entries = normalizedQuery(query, 1);
    expect(entries).toContain(
      "REFERENCES holiday_calendars(id) ON DELETE CASCADE",
    );
    expect(entries).toContain("end_date >= start_date");
    expect(entries).toContain("recurring BOOLEAN NOT NULL DEFAULT FALSE");

    const revisions = normalizedQuery(query, 4);
    expect(revisions).toContain(
      "REFERENCES holiday_calendars(id) ON DELETE CASCADE",
    );
    expect(revisions).toContain("snapshot JSONB NOT NULL");
    expect(revisions).toContain("UNIQUE (calendar_id, version)");
  });

  it("propagates a schema failure without issuing later statements", async () => {
    const { client, query } = mockClient();
    const error = new Error("schema unavailable");
    query.mockRejectedValueOnce(error);

    await expect(migration.up(client)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("drops revisions before entries and calendars during rollback", async () => {
    const { client, query } = mockClient();

    await migration.down(client);

    expect(query).toHaveBeenCalledTimes(3);
    expect(normalizedQuery(query, 0)).toBe(
      "DROP TABLE IF EXISTS holiday_calendar_revisions",
    );
    expect(normalizedQuery(query, 1)).toBe(
      "DROP TABLE IF EXISTS holiday_calendar_entries",
    );
    expect(normalizedQuery(query, 2)).toBe(
      "DROP TABLE IF EXISTS holiday_calendars",
    );
  });

  it("propagates a rollback failure and stops the rollback sequence", async () => {
    const { client, query } = mockClient();
    const error = new Error("rollback unavailable");
    query.mockRejectedValueOnce(error);

    await expect(migration.down(client)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
  });
});