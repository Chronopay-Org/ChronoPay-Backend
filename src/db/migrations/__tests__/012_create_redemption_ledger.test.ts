import type { PoolClient } from "pg";
import { describe, expect, it, jest } from "@jest/globals";
import { migration } from "../012_create_redemption_ledger.js";

function makeClient(query: jest.Mock<any>): PoolClient {
  return { query } as unknown as PoolClient;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

describe("012_create_redemption_ledger migration", () => {
  it("exposes the expected migration identity and lifecycle functions", () => {
    expect(migration.id).toBe("016");
    expect(migration.name).toBe("create_redemption_ledger");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("creates the ledger table and its chain-walk indexes in order", async () => {
    const query = jest.fn<any>().mockResolvedValue({ rows: [] });

    await migration.up(makeClient(query));

    expect(query).toHaveBeenCalledTimes(4);

    const [createTable, genesisIndex, previousHashIndex, createdAtIndex] = query.mock.calls.map(
      ([sql]) => normalizeSql(sql as string),
    );

    expect(createTable).toContain("create table redemption_ledger");
    expect(createTable).toContain("id uuid primary key default gen_random_uuid()");
    expect(createTable).toContain("redemption_id text not null unique");
    expect(createTable).toContain("token_id text not null");
    expect(createTable).toContain("redeemer_id text not null");
    expect(createTable).toContain("entry_hash text not null unique");
    expect(createTable).toContain("prev_hash text");
    expect(createTable).toContain("metadata jsonb");
    expect(createTable).toContain("created_at timestamptz not null default now()");

    expect(genesisIndex).toBe(
      "create unique index idx_redemption_ledger_genesis on redemption_ledger ((prev_hash is null)) where prev_hash is null",
    );
    expect(previousHashIndex).toBe(
      "create index idx_redemption_ledger_prev_hash on redemption_ledger (prev_hash)",
    );
    expect(createdAtIndex).toBe(
      "create index idx_redemption_ledger_created_at on redemption_ledger (created_at)",
    );
  });

  it.each([0, 1, 2, 3])("stops at the first database failure during up (query %s)", async (failureAt) => {
    const failure = new Error(`query ${failureAt} failed`);
    const query = jest.fn<any>();

    for (let index = 0; index < failureAt; index += 1) {
      query.mockResolvedValueOnce({ rows: [] });
    }
    query.mockRejectedValueOnce(failure);

    await expect(migration.up(makeClient(query))).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(failureAt + 1);
  });

  it("drops the ledger table on down and uses an idempotent drop", async () => {
    const query = jest.fn<any>().mockResolvedValue({ rows: [] });

    await migration.down(makeClient(query));

    expect(query).toHaveBeenCalledTimes(1);
    expect(normalizeSql(query.mock.calls[0][0] as string)).toBe("drop table if exists redemption_ledger");
  });

  it("propagates a rollback database failure without issuing another query", async () => {
    const failure = new Error("drop failed");
    const query = jest.fn<any>().mockRejectedValue(failure);

    await expect(migration.down(makeClient(query))).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
