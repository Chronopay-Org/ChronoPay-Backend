import type { PoolClient } from "pg";
import { jest } from "@jest/globals";
import { migration } from "../016_add_grace_window_config.js";

type Query = (text: string) => Promise<unknown>;

function mockClient(): { client: PoolClient; query: jest.MockedFunction<Query> } {
  const query = jest.fn<Query>();
  return { client: { query } as unknown as PoolClient, query };
}

function normalizedQuery(query: jest.MockedFunction<Query>, index: number): string {
  return query.mock.calls[index]?.[0].replace(/\s+/g, " ").trim() ?? "";
}

describe("migration 017 add_grace_window_config", () => {
  it("exposes the expected migration identity", () => {
    expect(migration.id).toBe("017");
    expect(migration.name).toBe("add_grace_window_config");
  });

  it("creates the config, history, and slots schema in dependency order", async () => {
    const { client, query } = mockClient();

    await migration.up(client);

    expect(query).toHaveBeenCalledTimes(8);
    expect(normalizedQuery(query, 0)).toContain("CREATE TABLE slot_category_grace_windows");
    expect(normalizedQuery(query, 1)).toContain("CREATE INDEX idx_grace_windows_category");
    expect(normalizedQuery(query, 2)).toContain("CREATE TABLE slot_category_grace_window_history");
    expect(normalizedQuery(query, 5)).toContain("ALTER TABLE slots ADD COLUMN category TEXT");
    expect(normalizedQuery(query, 7)).toContain("CREATE INDEX idx_slots_category");
  });

  it("encodes invalid-value boundaries in database constraints", async () => {
    const { client, query } = mockClient();

    await migration.up(client);

    const configTable = normalizedQuery(query, 0);
    expect(configTable).toContain("grace_window_seconds >= 1");
    expect(configTable).toContain("grace_window_seconds <= 86400");
    expect(configTable).toContain("char_length(category) <= 100");

    const historyTable = normalizedQuery(query, 2);
    expect(historyTable).toContain("new_grace_window_seconds >= 1");
    expect(historyTable).toContain("new_grace_window_seconds <= 86400");
    expect(historyTable).toContain(
      "previous_grace_window_seconds IS NULL OR previous_grace_window_seconds >= 1",
    );
    expect(historyTable).toContain("char_length(reason) <= 500");

    expect(normalizedQuery(query, 6)).toContain(
      "category IS NULL OR char_length(category) <= 100",
    );
  });

  it("propagates a schema failure without issuing later statements", async () => {
    const { client, query } = mockClient();
    const error = new Error("schema unavailable");
    query.mockRejectedValueOnce(error);

    await expect(migration.up(client)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("removes schema in the reverse dependency order", async () => {
    const { client, query } = mockClient();

    await migration.down(client);

    expect(query).toHaveBeenCalledTimes(8);
    expect(normalizedQuery(query, 0)).toContain("DROP INDEX IF EXISTS idx_slots_category");
    expect(normalizedQuery(query, 1)).toContain("DROP CONSTRAINT IF EXISTS chk_slots_category_len");
    expect(normalizedQuery(query, 2)).toContain("DROP COLUMN IF EXISTS category");
    expect(normalizedQuery(query, 3)).toContain(
      "DROP INDEX IF EXISTS idx_grace_window_history_changed_at",
    );
    expect(normalizedQuery(query, 5)).toContain(
      "DROP TABLE IF EXISTS slot_category_grace_window_history",
    );
    expect(normalizedQuery(query, 7)).toContain(
      "DROP TABLE IF EXISTS slot_category_grace_windows",
    );
  });

  it("propagates a rollback failure and stops the rollback sequence", async () => {
    const { client, query } = mockClient();
    const error = new Error("rollback unavailable");
    query.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);

    await expect(migration.down(client)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(2);
  });
});