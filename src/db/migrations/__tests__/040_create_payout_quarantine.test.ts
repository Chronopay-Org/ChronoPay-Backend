import { jest } from "@jest/globals";
import type { PoolClient } from "pg";
import { migration } from "../040_create_payout_quarantine.js";

describe("create_payout_quarantine migration", () => {
  it("creates the quarantine table and removes it on rollback", async () => {
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (text: string) => {
        statements.push(text.replace(/\s+/g, " ").trim());
        return { rows: [] };
      }),
    } as unknown as PoolClient;

    await migration.up(client);
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS payout_quarantine");
    expect(statements[0]).toContain("payout_id TEXT PRIMARY KEY");
    expect(statements[0]).toContain("total_failures INTEGER NOT NULL");
    expect(statements).toHaveLength(2);

    statements.length = 0;
    await migration.down(client);
    expect(statements).toEqual(["DROP TABLE IF EXISTS payout_quarantine"]);
  });
});
