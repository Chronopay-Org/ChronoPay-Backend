/**
 * Regression suite for migration 004 — `create_booking_intents_table`.
 *
 * Migrations are the one place where a quiet edit turns into data loss, so this
 * suite pins the emitted SQL rather than the rendered UI:
 * - the exact list of statements and the order they are issued in (the table
 *   depends on the enum type, the indexes depend on the table),
 * - the constraints that carry business meaning (one intent per slot, cascade
 *   on delete, and the end_time > start_time guard),
 * - the full enum value set,
 * - the teardown contract (`IF EXISTS`, table before type),
 * - what happens when a statement fails: the error is propagated unwrapped and
 *   the remaining statements are not attempted.
 *
 * The suite is pure — it drives the exported `up`/`down` with a recording fake
 * client, so it needs no database.
 */

import { describe, it, expect } from "@jest/globals";
import { migration } from "../004_create_booking_intents_table.js";

// ---------------------------------------------------------------------------
// Recording fake PoolClient
// ---------------------------------------------------------------------------

type QueryCall = { sql: string; argCount: number };

interface FakeClient {
  query: (sql: string, ...args: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}

/**
 * Builds a PoolClient stand-in that records every statement it is given.
 * `failWhen(sql, index)` lets a test force a specific statement to fail.
 */
function makeClient(failWhen?: (sql: string, index: number) => boolean) {
  const calls: QueryCall[] = [];
  const client: FakeClient = {
    async query(sql: string, ...args: unknown[]) {
      calls.push({ sql, argCount: args.length });
      if (failWhen && failWhen(sql, calls.length - 1)) {
        throw new Error('relation "booking_intents" already exists');
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls };
}

/** Collapses the multi-line template literals into single-space SQL for assertions. */
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

const run = (calls: QueryCall[]) => calls.map((c) => flat(c.sql));

// The migration is typed against pg's PoolClient; the fake is structurally
// sufficient for every call this file makes.
const asClient = (c: FakeClient) => c as unknown as Parameters<typeof migration.up>[0];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("migration 004 — create_booking_intents_table", () => {
  describe("definition", () => {
    it("is identified as migration 004", () => {
      expect(migration.id).toBe("004");
    });

    it("carries the schema-object name as its label", () => {
      expect(migration.name).toBe("create_booking_intents_table");
    });

    it("exposes up and down as functions", () => {
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });

    it("sorts before migration 005", () => {
      const ids = ["001", "002", "003", "004", "005"].sort();
      expect(ids.indexOf(migration.id)).toBeLessThan(ids.indexOf("005"));
    });
  });

  describe("up() — statement plan", () => {
    it("issues exactly five statements", async () => {
      const { client, calls } = makeClient();
      await migration.up(asClient(client));
      expect(calls).toHaveLength(5);
    });

    it("passes no bound parameters (DDL is inlined)", async () => {
      const { client, calls } = makeClient();
      await migration.up(asClient(client));
      expect(calls.every((c) => c.argCount === 0)).toBe(true);
    });

    it("creates the enum first, then the table", async () => {
      const { client, calls } = makeClient();
      await migration.up(asClient(client));
      const [first, second] = run(calls);
      expect(first).toMatch(/^CREATE TYPE booking_intent_status AS ENUM/);
      expect(second).toMatch(/^CREATE TABLE booking_intents/);
    });

    it("creates the three indexes last, after the table exists", async () => {
      const { client, calls } = makeClient();
      await migration.up(asClient(client));
      const statements = run(calls);
      const indexes = statements.slice(2);
      expect(indexes).toHaveLength(3);
      expect(indexes.every((s) => s.startsWith("CREATE INDEX"))).toBe(true);
    });

    it("declares exactly the four booking-intent statuses, in order", async () => {
      const { client, calls } = makeClient();
      await migration.up(asClient(client));
      const enumSql = run(calls)[0];
      const values = enumSql
        .slice(enumSql.indexOf("(") + 1, enumSql.lastIndexOf(")"))
        .split(",")
        .map((v) => v.trim().replace(/^'|'$/g, ""));
      expect(values).toEqual(["pending", "completed", "expired", "cancelled"]);
    });

    it("is deterministic across runs", async () => {
      const a = makeClient();
      const b = makeClient();
      await migration.up(asClient(a.client));
      await migration.up(asClient(b.client));
      expect(run(a.calls)).toEqual(run(b.calls));
    });

    it("does not guard with IF NOT EXISTS (re-runs rely on the runner bookkeeping)", async () => {
      // The runner records applied migrations, so `up()` is intentionally not
      // self-idempotent. Pinned so adding a guard is a deliberate choice.
      const { client, calls } = makeClient();
      await migration.up(asClient(client));
      const statements = run(calls);
      expect(statements[0]).not.toMatch(/IF NOT EXISTS/i);
      expect(statements[1]).not.toMatch(/IF NOT EXISTS/i);
    });
  });

  describe("up() — table contract", () => {
    const tableSql = async (): Promise<string> => {
      const { client, calls } = makeClient();
      await migration.up(asClient(client));
      return run(calls)[1];
    };

    it("generates the primary key as a random UUID", async () => {
      const sql = await tableSql();
      expect(sql).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    });

    it("allows a single booking intent per slot", async () => {
      const sql = await tableSql();
      expect(sql).toMatch(/slot_id UUID NOT NULL UNIQUE REFERENCES slots\(id\) ON DELETE CASCADE/);
    });

    it("references users for both the professional and the customer, cascading on delete", async () => {
      const sql = await tableSql();
      expect(sql).toMatch(/professional_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
      expect(sql).toMatch(/customer_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    });

    it("stores the window as NOT NULL TIMESTAMPTZ columns", async () => {
      const sql = await tableSql();
      expect(sql).toMatch(/start_time TIMESTAMPTZ NOT NULL/);
      expect(sql).toMatch(/end_time TIMESTAMPTZ NOT NULL/);
    });

    it("guards the window ordering with a CHECK constraint", async () => {
      const sql = await tableSql();
      expect(sql).toMatch(
        /CONSTRAINT chk_booking_intents_time_order CHECK \(end_time > start_time\)/,
      );
    });

    it("defaults the status to pending and types it as the new enum", async () => {
      const sql = await tableSql();
      expect(sql).toMatch(/status booking_intent_status NOT NULL DEFAULT 'pending'/);
    });

    it("keeps an optional note column", async () => {
      const sql = await tableSql();
      expect(sql).toMatch(/note TEXT/);
      expect(sql).not.toMatch(/note TEXT NOT NULL/);
    });

    it("stamps created_at and updated_at with NOW()", async () => {
      const sql = await tableSql();
      expect(sql).toMatch(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
      expect(sql).toMatch(/updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
    });
  });

  describe("up() — index contract", () => {
    const indexes = async (): Promise<string[]> => {
      const { client, calls } = makeClient();
      await migration.up(asClient(client));
      return run(calls).slice(2);
    };

    it("indexes the slot foreign key", async () => {
      const sqls = await indexes();
      expect(sqls).toContain(
        "CREATE INDEX idx_booking_intents_slot_id ON booking_intents (slot_id)",
      );
    });

    it("indexes the customer foreign key", async () => {
      const sqls = await indexes();
      expect(sqls).toContain(
        "CREATE INDEX idx_booking_intents_customer_id ON booking_intents (customer_id)",
      );
    });

    it("indexes the professional foreign key", async () => {
      const sqls = await indexes();
      expect(sqls).toContain(
        "CREATE INDEX idx_booking_intents_professional_id ON booking_intents (professional_id)",
      );
    });

    it("covers every foreign key with an index", async () => {
      const sqls = await indexes();
      const covered = sqls.map((s) => s.slice(s.indexOf("(") + 1, s.lastIndexOf(")")));
      expect(covered.sort()).toEqual(["customer_id", "professional_id", "slot_id"]);
    });
  });

  describe("down()", () => {
    it("issues exactly two statements", async () => {
      const { client, calls } = makeClient();
      await migration.down(asClient(client));
      expect(calls).toHaveLength(2);
    });

    it("drops the table before the type it depends on", async () => {
      const { client, calls } = makeClient();
      await migration.down(asClient(client));
      const [first, second] = run(calls);
      expect(first).toMatch(/^DROP TABLE/);
      expect(second).toMatch(/^DROP TYPE/);
    });

    it("uses IF EXISTS so a partially applied migration can still be torn down", async () => {
      const { client, calls } = makeClient();
      await migration.down(asClient(client));
      const statements = run(calls);
      expect(statements[0]).toBe("DROP TABLE IF EXISTS booking_intents");
      expect(statements[1]).toBe("DROP TYPE IF EXISTS booking_intent_status");
    });

    it("targets the objects that up() created", async () => {
      const up = makeClient();
      const down = makeClient();
      await migration.up(asClient(up.client));
      await migration.down(asClient(down.client));
      const createdTable = run(up.calls)[1].match(/CREATE TABLE (\w+)/)?.[1];
      const droppedTable = run(down.calls)[0].match(/DROP TABLE IF EXISTS (\w+)/)?.[1];
      const createdType = run(up.calls)[0].match(/CREATE TYPE (\w+)/)?.[1];
      const droppedType = run(down.calls)[1].match(/DROP TYPE IF EXISTS (\w+)/)?.[1];
      expect(droppedTable).toBe(createdTable);
      expect(droppedType).toBe(createdType);
    });

    it("is idempotent by construction (IF EXISTS on both statements)", async () => {
      const { client, calls } = makeClient();
      await migration.down(asClient(client));
      expect(run(calls).every((s) => /IF EXISTS/.test(s))).toBe(true);
    });
  });

  describe("failure handling", () => {
    it("propagates the underlying error unwrapped when the enum creation fails", async () => {
      const { client, calls } = makeClient((_sql, i) => i === 0);
      await expect(migration.up(asClient(client))).rejects.toThrow(
        'relation "booking_intents" already exists',
      );
      expect(calls).toHaveLength(1);
    });

    it("stops before creating indexes when the table creation fails", async () => {
      const { client, calls } = makeClient((sql) => sql.includes("CREATE TABLE"));
      await expect(migration.up(asClient(client))).rejects.toThrow(/already exists/);
      expect(calls).toHaveLength(2);
      expect(run(calls).some((s) => s.startsWith("CREATE INDEX"))).toBe(false);
    });

    it("stops as soon as an index creation fails", async () => {
      const { client, calls } = makeClient((sql) => sql.includes("CREATE INDEX"));
      await expect(migration.up(asClient(client))).rejects.toThrow(/already exists/);
      // enum + table + the one index that failed
      expect(calls).toHaveLength(3);
    });

    it("propagates failures from down() without swallowing them", async () => {
      const { client, calls } = makeClient((sql) => sql.includes("DROP TABLE"));
      await expect(migration.down(asClient(client))).rejects.toThrow(/already exists/);
      expect(calls).toHaveLength(1);
    });

    it("surfaces a synchronously throwing client instead of hanging", async () => {
      const client = {
        query() {
          throw new Error("client is closed");
        },
      };
      await expect(migration.up(asClient(client as unknown as FakeClient))).rejects.toThrow(
        "client is closed",
      );
    });

    it("does not attempt any statement when the client is unusable", async () => {
      let touched = 0;
      const client = {
        query() {
          touched++;
          throw new Error("client is closed");
        },
      };
      await expect(migration.up(asClient(client as unknown as FakeClient))).rejects.toThrow(
        "client is closed",
      );
      expect(touched).toBe(1);
    });
  });
});
