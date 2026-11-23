import type { PoolClient } from "pg";
import { migration } from "../014_add_slot_geo_fields.js";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function createRecordingClient(onQuery?: (sql: string, call: number) => Promise<void>) {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      await onQuery?.(sql, statements.length);
      return { rows: [] };
    },
  } as unknown as PoolClient;

  return { client, statements };
}

describe("014_add_slot_geo_fields migration", () => {
  it("adds nullable geo columns, coordinate bounds, consistency, and a partial index", async () => {
    expect(migration).toMatchObject({ id: "014", name: "add_slot_geo_fields" });
    const { client, statements } = createRecordingClient();

    await migration.up(client);

    expect(statements).toHaveLength(5);
    expect(normalizeSql(statements[0])).toContain(
      "ADD COLUMN latitude NUMERIC(9,6), ADD COLUMN longitude NUMERIC(9,6), ADD COLUMN h3_cell_res7 VARCHAR(20)",
    );

    const latitudeConstraint = normalizeSql(statements[1]);
    expect(latitudeConstraint).toContain(
      "CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90))",
    );

    const longitudeConstraint = normalizeSql(statements[2]);
    expect(longitudeConstraint).toContain(
      "CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))",
    );

    const consistencyConstraint = normalizeSql(statements[3]);
    expect(consistencyConstraint).toContain(
      "(latitude IS NULL AND longitude IS NULL AND h3_cell_res7 IS NULL)",
    );
    expect(consistencyConstraint).toContain(
      "(latitude IS NOT NULL AND longitude IS NOT NULL AND h3_cell_res7 IS NOT NULL)",
    );

    expect(normalizeSql(statements[4])).toContain(
      "CREATE INDEX idx_slots_h3_cell_res7 ON slots (h3_cell_res7) WHERE h3_cell_res7 IS NOT NULL",
    );
  });

  it("propagates a database error and stops issuing later statements", async () => {
    const databaseError = new Error("constraint creation failed");
    const { client, statements } = createRecordingClient(async (_sql, call) => {
      if (call === 3) throw databaseError;
    });

    await expect(migration.up(client)).rejects.toBe(databaseError);
    expect(statements).toHaveLength(3);
  });

  it("rolls back the index, constraints, and columns in dependency-safe order", async () => {
    const { client, statements } = createRecordingClient();

    await migration.down(client);

    expect(statements).toHaveLength(2);
    expect(normalizeSql(statements[0])).toBe("DROP INDEX IF EXISTS idx_slots_h3_cell_res7");

    const rollback = normalizeSql(statements[1]);
    expect(rollback).toContain("DROP CONSTRAINT IF EXISTS chk_slots_geo_consistency");
    expect(rollback).toContain("DROP CONSTRAINT IF EXISTS chk_slots_longitude_valid");
    expect(rollback).toContain("DROP CONSTRAINT IF EXISTS chk_slots_latitude_valid");
    expect(rollback).toContain("DROP COLUMN IF EXISTS h3_cell_res7");
    expect(rollback).toContain("DROP COLUMN IF EXISTS longitude");
    expect(rollback).toContain("DROP COLUMN IF EXISTS latitude");
  });
});
