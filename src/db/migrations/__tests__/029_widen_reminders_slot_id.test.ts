import type { PoolClient } from "pg";
import { migration } from "../029_widen_reminders_slot_id.js";
import { migrations } from "../index.js";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function createRecordingClient(blockingRows = 0) {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(normalizeSql(sql));
      if (/SELECT COUNT/i.test(sql)) {
        return { rows: [{ count: blockingRows }] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, statements };
}

describe("029_widen_reminders_slot_id migration", () => {
  it("has the next sequential id and a descriptive name", () => {
    expect(migration).toMatchObject({ id: "040", name: "widen_reminders_slot_id" });
  });

  it("is registered last in the migration registry, at the position its id implies", () => {
    expect(migrations[migrations.length - 1]).toBe(migration);
    expect(migrations.indexOf(migration) + 1).toBe(Number(migration.id));
  });

  describe("up", () => {
    it("changes slot_id to TEXT, keeping existing integers as their decimal text", async () => {
      const { client, statements } = createRecordingClient();
      await migration.up(client);

      expect(statements[0]).toBe(
        "ALTER TABLE reminders ALTER COLUMN slot_id TYPE TEXT USING slot_id::text",
      );
    });

    it("adds a composite (slot_id, trigger_at) index for the duplicate lookup", async () => {
      const { client, statements } = createRecordingClient();
      await migration.up(client);

      expect(statements).toHaveLength(2);
      expect(statements[1]).toBe(
        "CREATE INDEX IF NOT EXISTS idx_reminders_slot_id_trigger_at ON reminders (slot_id, trigger_at)",
      );
    });

    it("does not create a UNIQUE index, because existing rows may already hold duplicates", async () => {
      const { client, statements } = createRecordingClient();
      await migration.up(client);
      expect(statements.join("\n")).not.toMatch(/UNIQUE/i);
    });

    it("never deletes or rewrites reminder rows", async () => {
      const { client, statements } = createRecordingClient();
      await migration.up(client);
      expect(statements.join("\n")).not.toMatch(/DELETE|UPDATE|TRUNCATE|DROP/i);
    });

    it("propagates a database error instead of swallowing it", async () => {
      const client = {
        query: async () => {
          throw new Error("boom");
        },
      } as unknown as PoolClient;
      await expect(migration.up(client)).rejects.toThrow("boom");
    });
  });

  describe("down", () => {
    it("drops the index and restores INTEGER when every slot_id is an integer", async () => {
      const { client, statements } = createRecordingClient(0);
      await migration.down(client);

      expect(statements[0]).toMatch(/SELECT COUNT\(\*\)::int AS count FROM reminders WHERE slot_id !~/);
      expect(statements[1]).toBe("DROP INDEX IF EXISTS idx_reminders_slot_id_trigger_at");
      expect(statements[2]).toBe(
        "ALTER TABLE reminders ALTER COLUMN slot_id TYPE INTEGER USING slot_id::integer",
      );
    });

    it("refuses to roll back, changing nothing, while string slot ids exist", async () => {
      const { client, statements } = createRecordingClient(3);

      await expect(migration.down(client)).rejects.toThrow(
        /Cannot roll back migration 040: 3 reminder\(s\)/,
      );
      expect(statements).toHaveLength(1); // only the check ran
    });

    it("treats a missing count row as zero blocking reminders", async () => {
      const statements: string[] = [];
      const client = {
        query: async (sql: string) => {
          statements.push(normalizeSql(sql));
          return { rows: [] };
        },
      } as unknown as PoolClient;

      await migration.down(client);
      expect(statements).toHaveLength(3);
    });
  });
});
