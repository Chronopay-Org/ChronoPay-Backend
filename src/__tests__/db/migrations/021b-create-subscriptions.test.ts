// @ts-nocheck
/**
 * Focused behavior tests for src/db/migrations/021b_create_subscriptions.ts
 *
 * Coverage strategy
 * -----------------
 * The migration's public contract is the ordered sequence of SQL statements it
 * sends to the supplied PoolClient. Every observation below is behavioral: we
 * execute migration.up()/down() against a recording client (per-test clone,
 * non-serializable identity so no test can observe another's writes) and assert
 * on the captured statements.
 *
 * Because an assertion that only ever inspects the happy path can pass
 * vacuously, each inventory test is paired with a P2 mutation clone whose
 * up/down/id has been swapped for an alternative implementation. The mutated
 * module MUST produce a provably different observation, proving the assertion
 * is actually sensitive to the real implementation (see issue #1066).
 *
 * Failure paths use representative invalid inputs: a database where the enum
 * type already exists, where the FK parent table is missing, or where an index
 * name collides. PostgreSQL rejects these deterministically, so the mock
 * client's rejection is a faithful stand-in. Because the runner wraps up()/down()
 * in a transaction, a mid-sequence failure must abort deterministically: the
 * statements before the failure may have been issued, but nothing after, and
 * the whole transaction is rolled back by the runner (verified separately in
 * src/__tests__/db/connection.test.ts).
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import type { PoolClient, QueryResult } from "pg";
import { MigrationRunner, type Migration } from "../../../db/migrationRunner.js";
import type { MigrationRepository, AppliedMigration } from "../../../db/migrationRepository.js";
import { migration } from "../../../db/migrations/021b_create_subscriptions.js";

// ─── Recording client plumbing ────────────────────────────────────────────────

/** Non-serializable sentinel — forbids clone identity comparison across tests. */
class ClientIdentity {
  readonly token: symbol;
  constructor(label: string) {
    this.token = Symbol(label);
  }
}

interface RecordedCall {
  sql: string;
  values?: unknown[];
  clientIdentity: ClientIdentity;
}

const recorded: RecordedCall[] = [];

/** Deterministic empty result set — the migration ignores query results. */
const emptyResult: QueryResult = {
  rows: [],
  rowCount: 0,
  command: "",
  oid: 0,
  fields: [],
};

/** Build a PoolClient that records every statement it is asked to run. */
function makeRecordingClient(identity: ClientIdentity): PoolClient {
  return {
    query: (text: string, values?: unknown[]) => {
      recorded.push({ sql: text, values, clientIdentity: identity });
      return Promise.resolve(emptyResult);
    },
    release: () => {},
  } as unknown as PoolClient;
}

/**
 * Build a PoolClient that rejects the Nth (1-based) statement with `error`.
 * Statements before the Nth are recorded (they were issued); the Nth and
 * everything after are not (up() aborts on first failure).
 */
function makeFailingClient(identity: ClientIdentity, failOnCall: number, error: Error): PoolClient {
  let calls = 0;
  return {
    query: (text: string, values?: unknown[]) => {
      calls += 1;
      if (calls === failOnCall) {
        return Promise.reject(error);
      }
      recorded.push({ sql: text, values, clientIdentity: identity });
      return Promise.resolve(emptyResult);
    },
    release: () => {},
  } as unknown as PoolClient;
}

/** Collapse whitespace so multi-line template-literal SQL compares cleanly. */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Run migration.up() against a fresh recording client; return normalized SQL. */
async function collectUpSql(m: Migration): Promise<string[]> {
  const before = recorded.length;
  const identity = new ClientIdentity("up-collector");
  await m.up(makeRecordingClient(identity));
  return recorded.slice(before).map((c) => normalizeSql(c.sql));
}

/** Run migration.down() against a fresh recording client; return normalized SQL. */
async function collectDownSql(m: Migration): Promise<string[]> {
  const before = recorded.length;
  const identity = new ClientIdentity("down-collector");
  await m.down(makeRecordingClient(identity));
  return recorded.slice(before).map((c) => normalizeSql(c.sql));
}

/** Statements recorded for a specific client identity (isolates failure tests). */
function recordedFor(identity: ClientIdentity): string[] {
  return recorded.filter((c) => c.clientIdentity === identity).map((c) => normalizeSql(c.sql));
}

// ─── The real contract, spelled out (normalized single-space form) ───────────

const CREATE_TABLE_SQL = normalizeSql(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id                  UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id          UUID                 NOT NULL REFERENCES subscription_products(id) ON DELETE CASCADE,
    subscriber_id       TEXT                 NOT NULL,
    status              subscription_status  NOT NULL DEFAULT 'active',
    next_slot_start_ms  BIGINT               NOT NULL,
    slot_offset_ms      INTEGER              NOT NULL DEFAULT 0,
    slots_minted        INTEGER              NOT NULL DEFAULT 0,
    paused_at           TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ          NOT NULL DEFAULT NOW()
  )
`);

const EXPECTED_UP_STATEMENTS = [
  `CREATE TYPE subscription_status AS ENUM ( 'active', 'paused', 'cancelled' );`,
  CREATE_TABLE_SQL,
  `CREATE INDEX idx_subscriptions_product_id ON subscriptions (product_id)`,
  `CREATE INDEX idx_subscriptions_subscriber_id ON subscriptions (subscriber_id)`,
  `CREATE INDEX idx_subscriptions_status_next_slot ON subscriptions (status, next_slot_start_ms) WHERE status = 'active'`,
  `CREATE UNIQUE INDEX idx_subscriptions_active_per_product ON subscriptions (product_id, subscriber_id) WHERE status IN ('active', 'paused')`,
];

const EXPECTED_DOWN_STATEMENTS = [
  `DROP TABLE IF EXISTS subscriptions`,
  `DROP TYPE IF EXISTS subscription_status`,
];

// ─── P2 mutation clones (each observation needs a witness) ───────────────────

/**
 * Clones of the migration whose behavior has been swapped. They exist only to
 * prove that the real implementation's contract assertions are non-vacuous:
 * each clone is fed to the same helper and must yield a different observation.
 */

/** A clone whose up() issues a plausible-but-different DDL sequence. */
const mutatedUp: Migration = {
  id: "021b",
  name: "create_subscriptions",
  async up(client: PoolClient): Promise<void> {
    await client.query(`CREATE TYPE subscription_status AS ENUM ('active')`);
    await client.query(`CREATE TABLE IF NOT EXISTS subscriptions (id UUID PRIMARY KEY)`);
    await client.query(`CREATE INDEX idx_subscriptions_product_id ON subscriptions (product_id)`);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS subscriptions`);
  },
};

/** A clone whose down() drops in the wrong order (type before table). */
const mutatedDown: Migration = {
  ...migration,
  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TYPE IF EXISTS subscription_status`);
    await client.query(`DROP TABLE IF EXISTS subscriptions`);
  },
};

/** A clone with a corrupted identity — same SQL, wrong id/name. */
const mutatedIdentity: Migration = {
  ...migration,
  id: "021X",
  name: "create_subscriptions_renamed",
};

// ─── Isolation between tests ─────────────────────────────────────────────────

beforeEach(() => {
  recorded.length = 0;
});

// ─── Migration contract ───────────────────────────────────────────────────────

describe("migration 021b — create_subscriptions", () => {
  describe("Migration contract", () => {
    it("exposes id '021b' (ordering anchor in the registry)", () => {
      expect(migration.id).toBe("021b");
      expect(mutatedIdentity.id).not.toBe(migration.id);
    });

    it("exposes name 'create_subscriptions'", () => {
      expect(migration.name).toBe("create_subscriptions");
      expect(mutatedIdentity.name).not.toBe(migration.name);
    });

    it("exposes up() and down() as functions (Migration interface)", () => {
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });
  });

  // ─── up(): success path ─────────────────────────────────────────────────────

  describe("up()", () => {
    it("resolves on the success path", async () => {
      const identity = new ClientIdentity("up-success");
      await expect(migration.up(makeRecordingClient(identity))).resolves.toBeUndefined();
    });

    it("issues exactly six DDL statements in contract order", async () => {
      const sqls = await collectUpSql(migration);
      expect(sqls).toHaveLength(6);
      EXPECTED_UP_STATEMENTS.forEach((expected, i) => {
        expect(sqls[i]).toBe(expected);
      });
    });

    it("is non-vacuous: a mutated up() does NOT satisfy the inventory", async () => {
      const sqls = await collectUpSql(mutatedUp);
      expect(sqls).not.toEqual(EXPECTED_UP_STATEMENTS);
      // Specifically: it loses the table's full column list and 3 of 4 indexes.
      expect(sqls).toHaveLength(3);
    });

    it("creates the enum with exactly the three lifecycle states", async () => {
      const [enumStmt] = await collectUpSql(migration);
      expect(enumStmt).toBe(EXPECTED_UP_STATEMENTS[0]);
      expect(enumStmt).toContain("'active'");
      expect(enumStmt).toContain("'paused'");
      expect(enumStmt).toContain("'cancelled'");
      expect(enumStmt).not.toContain("pending"); // boundary: no extra states
    });

    it("binds subscriptions to subscription_products with ON DELETE CASCADE", async () => {
      const sqls = await collectUpSql(migration);
      expect(sqls[1]).toContain("REFERENCES subscription_products(id)");
      expect(sqls[1]).toContain("ON DELETE CASCADE");
    });

    it("defaults status to 'active' and timestamps to NOW()", async () => {
      const sqls = await collectUpSql(migration);
      expect(sqls[1]).toContain("status subscription_status NOT NULL DEFAULT 'active'");
      expect(sqls[1]).toContain("created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      expect(sqls[1]).toContain("updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    });

    it("keeps paused_at and cancelled_at nullable (state-transition timestamps)", async () => {
      const sqls = await collectUpSql(migration);
      // Nullable = the column definition is NOT followed by NOT NULL.
      expect(sqls[1]).toMatch(/paused_at TIMESTAMPTZ(?! NOT NULL)/);
      expect(sqls[1]).toMatch(/cancelled_at TIMESTAMPTZ(?! NOT NULL)/);
    });

    it("exposes next_slot_start_ms as a NOT NULL BIGINT cursor", async () => {
      const sqls = await collectUpSql(migration);
      expect(sqls[1]).toContain("next_slot_start_ms BIGINT NOT NULL");
    });

    it("creates a partial unique index allowing one live subscription per (product_id, subscriber_id)", async () => {
      const sqls = await collectUpSql(migration);
      const uniqueIdx = sqls.find((s) =>
        s.startsWith("CREATE UNIQUE INDEX idx_subscriptions_active_per_product"),
      );
      expect(uniqueIdx).toBeDefined();
      expect(uniqueIdx).toContain("(product_id, subscriber_id)");
      // The partial predicate must NOT include 'cancelled' — cancelled rows
      // must be free to coexist so a subscriber can re-subscribe.
      expect(uniqueIdx).toContain("WHERE status IN ('active', 'paused')");
      expect(uniqueIdx).not.toContain("'cancelled'");
    });

    it("creates a partial btree index over due active subscriptions for the generator worker", async () => {
      const sqls = await collectUpSql(migration);
      expect(sqls).toContain(
        "CREATE INDEX idx_subscriptions_status_next_slot ON subscriptions (status, next_slot_start_ms) WHERE status = 'active'",
      );
    });

    it("creates plain lookup indexes on product_id and subscriber_id", async () => {
      const sqls = await collectUpSql(migration);
      expect(sqls).toContain(
        "CREATE INDEX idx_subscriptions_product_id ON subscriptions (product_id)",
      );
      expect(sqls).toContain(
        "CREATE INDEX idx_subscriptions_subscriber_id ON subscriptions (subscriber_id)",
      );
    });
  });

  // ─── up(): invalid inputs / failure paths ───────────────────────────────────

  describe("up() — failure paths", () => {
    it("propagates the error when the enum type already exists (re-run boundary)", async () => {
      const identity = new ClientIdentity("dup-enum");
      const boom = new Error('type "subscription_status" already exists');
      const client = makeFailingClient(identity, 1, boom);

      await expect(migration.up(client)).rejects.toThrow(
        'type "subscription_status" already exists',
      );
      // Fail-fast at statement 1: nothing further was attempted.
      expect(recordedFor(identity)).toHaveLength(0);
    });

    it("propagates the error when the FK parent table is missing", async () => {
      const identity = new ClientIdentity("missing-parent");
      const boom = new Error('relation "subscription_products" does not exist');
      const client = makeFailingClient(identity, 2, boom);

      await expect(migration.up(client)).rejects.toThrow(
        'relation "subscription_products" does not exist',
      );
      // Exactly the prefix before the failure was issued; nothing after.
      expect(recordedFor(identity)).toEqual([EXPECTED_UP_STATEMENTS[0]]);
    });

    it("propagates the error when an index name collides", async () => {
      const identity = new ClientIdentity("dup-index");
      const boom = new Error('relation "idx_subscriptions_product_id" already exists');
      const client = makeFailingClient(identity, 3, boom);

      await expect(migration.up(client)).rejects.toThrow(
        'relation "idx_subscriptions_product_id" already exists',
      );
      expect(recordedFor(identity)).toEqual(EXPECTED_UP_STATEMENTS.slice(0, 2));
    });

    it("aborts deterministically after the first failure (no writes after it)", async () => {
      const identity = new ClientIdentity("mid-sequence");
      const client = makeFailingClient(identity, 2, new Error("boom"));

      await expect(migration.up(client)).rejects.toThrow("boom");
      // Statement 1 was issued, statements 2..6 were not — the runner's
      // surrounding transaction is responsible for rolling back the prefix.
      expect(recordedFor(identity)).toEqual([EXPECTED_UP_STATEMENTS[0]]);
    });
  });

  // ─── down(): success path ───────────────────────────────────────────────────

  describe("down()", () => {
    it("resolves on the success path", async () => {
      const identity = new ClientIdentity("down-success");
      await expect(migration.down(makeRecordingClient(identity))).resolves.toBeUndefined();
    });

    it("drops the table before the type, both IF EXISTS", async () => {
      const sqls = await collectDownSql(migration);
      expect(sqls).toEqual(EXPECTED_DOWN_STATEMENTS);
    });

    it("is non-vacuous: a mutated down() reverses the drop order", async () => {
      const sqls = await collectDownSql(mutatedDown);
      expect(sqls).not.toEqual(EXPECTED_DOWN_STATEMENTS);
      expect(sqls[0]).toContain("DROP TYPE");
    });
  });

  describe("down() — failure paths", () => {
    it("propagates the error when the table drop fails", async () => {
      const identity = new ClientIdentity("down-fail-table");
      const client = makeFailingClient(
        identity,
        1,
        new Error("cannot drop table subscriptions because other objects depend on it"),
      );

      await expect(migration.down(client)).rejects.toThrow("cannot drop table subscriptions");
      expect(recordedFor(identity)).toHaveLength(0);
    });

    it("propagates the error when the type drop fails", async () => {
      const identity = new ClientIdentity("down-fail-type");
      const client = makeFailingClient(
        identity,
        2,
        new Error("cannot drop type subscription_status"),
      );

      await expect(migration.down(client)).rejects.toThrow("cannot drop type subscription_status");
      // Only the table drop was issued before the failure.
      expect(recordedFor(identity)).toEqual([EXPECTED_DOWN_STATEMENTS[0]]);
    });
  });

  // ─── Runner integration: the registry-facing contract ───────────────────────

  describe("MigrationRunner round-trip", () => {
    /**
     * Transaction helper injected into the runner (its 4th constructor param
     * exists exactly for this) so no real pool/DATABASE_URL is needed.
     */
    const passthroughTransact = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
      fn(makeRecordingClient(new ClientIdentity("runner-transact")));

    function makeRepo(): { repo: MigrationRepository; calls: string[] } {
      const calls: string[] = [];
      // Stateful in-memory tracking table, mirroring the real repository so the
      // up→down round-trip is observable end to end.
      const applied = new Map<string, AppliedMigration>();
      const repo: MigrationRepository = {
        ensureMigrationsTable: async () => {
          calls.push("ensureMigrationsTable");
        },
        getAppliedMigrations: async () => {
          calls.push("getAppliedMigrations");
          return [...applied.values()];
        },
        recordMigration: async (_client, id, name) => {
          calls.push(`record:${id}:${name}`);
          applied.set(id, { id, name, applied_at: new Date() });
        },
        removeMigration: async (_client, id) => {
          calls.push(`remove:${id}`);
          applied.delete(id);
        },
      };
      return { repo, calls };
    }

    it("registers 021b through runner.up() and rolls it back through runner.down()", async () => {
      const { repo, calls } = makeRepo();
      const runner = new MigrationRunner({} as never, repo, [migration], passthroughTransact);

      const up = await runner.up();
      expect(up.success).toBe(true);
      expect(up.applied).toEqual(["021b"]);
      expect(calls).toContain("record:021b:create_subscriptions");

      const down = await runner.down();
      expect(down.success).toBe(true);
      expect(down.applied).toEqual(["021b"]);
      expect(calls).toContain("remove:021b");
    });

    it("reports a failed migration with the id and error, and records nothing", async () => {
      const { repo, calls } = makeRepo();
      // A clone that fails mid-up: the runner must surface the failure.
      const failing: Migration = {
        ...migration,
        async up(client: PoolClient): Promise<void> {
          await client.query(`CREATE TYPE subscription_status AS ENUM ('active')`);
          throw new Error('type "subscription_status" already exists');
        },
      };
      const runner = new MigrationRunner({} as never, repo, [failing], passthroughTransact);

      const result = await runner.up();
      expect(result.success).toBe(false);
      expect(result.failed).toBe("021b");
      expect(result.error?.message).toContain("already exists");
      expect(calls).not.toContain("record:021b:create_subscriptions");
    });
  });
});
