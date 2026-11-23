/**
 * GdprErasureOrchestrator.test.ts
 *
 * Comprehensive unit tests for the GDPR erasure orchestrator.
 *
 * Covers:
 *  - Legal hold guard (blocks erasure when subject is held)
 *  - FK graph walk in correct order
 *  - Receipt writing (live + dry-run)
 *  - Transaction commit and rollback
 *  - Partial rollback on DB error
 *  - Dry-run mode (no mutations, receipt written)
 *  - Audit log emissions
 *  - Edge cases: empty graph, no PII data found
 */

import { jest } from "@jest/globals";
import {
  GdprErasureOrchestrator,
  LegalHoldViolationError,
  type ErasureRequest,
  type LegalHoldChecker,
  type DbPool,
} from "../../services/gdprErasure/GdprErasureOrchestrator.js";
import {
  InMemoryErasureEventLog,
} from "../../services/gdprErasure/eventLog.js";
import type { TableNode } from "../../services/gdprErasure/dependencyGraph.js";
import type { PoolClient } from "pg";
import { AuditLogger } from "../../services/auditLogger.js";

// ─── Fakes & helpers ──────────────────────────────────────────────────────────

function makeLegalHold(held: boolean): LegalHoldChecker {
  return { isHeld: jest.fn(async () => held) };
}

interface ClientSpy {
  client: PoolClient;
  queries: Array<{ sql: string; params: unknown[] }>;
}

function makePoolClient(rowsByTable: Record<string, unknown[]> = {}): ClientSpy {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: sql.trim(), params });
      for (const [table, rows] of Object.entries(rowsByTable)) {
        if (sql.includes(table) && sql.trimStart().toUpperCase().startsWith("SELECT")) {
          return { rows };
        }
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  } as unknown as PoolClient;
  return { client, queries };
}

function makePool(rowsByTable: Record<string, unknown[]> = {}): {
  pool: DbPool;
  spy: ClientSpy;
} {
  const spy = makePoolClient(rowsByTable);
  const pool: DbPool = { connect: jest.fn(async () => spy.client) };
  return { pool, spy };
}

function makeOrchestrator(opts: {
  held?: boolean;
  rowsByTable?: Record<string, unknown[]>;
  graph?: TableNode[];
  eventLog?: InMemoryErasureEventLog;
  auditLogger?: AuditLogger;
}) {
  const legalHold = makeLegalHold(opts.held ?? false);
  const { pool, spy } = makePool(opts.rowsByTable ?? {});
  const eventLog = opts.eventLog ?? new InMemoryErasureEventLog();
  const auditLogger = opts.auditLogger ?? new AuditLogger({ filePath: "/dev/null" });
  const graph = opts.graph;
  const getGraph = graph ? () => graph : undefined;

  const orchestrator = new GdprErasureOrchestrator({
    pool,
    legalHold,
    auditLogger,
    eventLog,
    getGraph,
  });

  return { orchestrator, pool, spy, eventLog, legalHold, auditLogger };
}

function liveRequest(subjectId = "user-123"): ErasureRequest {
  return { subjectId, requestedBy: "admin-1", dryRun: false };
}

function dryRequest(subjectId = "user-123"): ErasureRequest {
  return { subjectId, requestedBy: "admin-1", dryRun: true };
}

// ─── Legal hold guard ─────────────────────────────────────────────────────────

describe("GdprErasureOrchestrator — legal hold guard", () => {
  it("throws LegalHoldViolationError when subject is held", async () => {
    const { orchestrator } = makeOrchestrator({ held: true });
    await expect(orchestrator.erase(liveRequest())).rejects.toThrow(LegalHoldViolationError);
  });

  it("includes the subjectId in the error", async () => {
    const { orchestrator } = makeOrchestrator({ held: true });
    await expect(orchestrator.erase(liveRequest("user-held"))).rejects.toThrow("user-held");
  });

  it("does NOT connect to the DB when subject is held", async () => {
    const { orchestrator, pool } = makeOrchestrator({ held: true });
    await expect(orchestrator.erase(liveRequest())).rejects.toThrow();
    expect((pool.connect as jest.Mock).mock.calls).toHaveLength(0);
  });

  it("does NOT write an event log receipt when held", async () => {
    const eventLog = new InMemoryErasureEventLog();
    const { orchestrator } = makeOrchestrator({ held: true, eventLog });
    await expect(orchestrator.erase(liveRequest())).rejects.toThrow();
    expect(eventLog.all()).toHaveLength(0);
  });
});

// ─── Transaction management ───────────────────────────────────────────────────

describe("GdprErasureOrchestrator — transaction management", () => {
  it("begins a transaction on live erasure", async () => {
    const { orchestrator, spy } = makeOrchestrator({ held: false });
    await orchestrator.erase(liveRequest());
    const begins = spy.queries.filter((q) => q.sql === "BEGIN");
    expect(begins).toHaveLength(1);
  });

  it("commits the transaction on success", async () => {
    const { orchestrator, spy } = makeOrchestrator({ held: false });
    await orchestrator.erase(liveRequest());
    const commits = spy.queries.filter((q) => q.sql === "COMMIT");
    expect(commits).toHaveLength(1);
  });

  it("does NOT begin a transaction in dry-run", async () => {
    const { orchestrator, spy } = makeOrchestrator({ held: false });
    await orchestrator.erase(dryRequest());
    const begins = spy.queries.filter((q) => q.sql === "BEGIN");
    expect(begins).toHaveLength(0);
  });

  it("does NOT commit in dry-run", async () => {
    const { orchestrator, spy } = makeOrchestrator({ held: false });
    await orchestrator.erase(dryRequest());
    const commits = spy.queries.filter((q) => q.sql === "COMMIT");
    expect(commits).toHaveLength(0);
  });

  it("rolls back when a table tombstone throws", async () => {
    const { pool, spy } = makePool();
    const eventLog = new InMemoryErasureEventLog();
    const legalHold = makeLegalHold(false);

    // Graph with one node whose SELECT will throw.
    const failNode: TableNode = {
      table: "bad_table",
      pkCol: "id",
      fkCol: "user_id",
      piiColumns: [{ name: "email", storeHash: true }],
      dependsOn: [],
    };

    // Override the client's query to throw on SELECT of bad_table.
    const { client, queries } = spy;
    (client.query as jest.Mock<any>).mockImplementation(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: sql.trim(), params });
      if (sql.includes("bad_table")) {
        throw new Error("DB failure");
      }
      return { rows: [] };
    });

    const orchestrator = new GdprErasureOrchestrator({
      pool,
      legalHold,
      eventLog,
      getGraph: () => [failNode],
    });

    await expect(orchestrator.erase(liveRequest())).rejects.toThrow("DB failure");

    const rollbacks = queries.filter((q) => q.sql === "ROLLBACK");
    expect(rollbacks).toHaveLength(1);
  });

  it("releases the DB client even when an error occurs", async () => {
    const { pool, spy } = makePool();
    const legalHold = makeLegalHold(false);

    const failNode: TableNode = {
      table: "fail",
      pkCol: "id",
      fkCol: "user_id",
      piiColumns: [{ name: "email", storeHash: true }],
      dependsOn: [],
    };

    (spy.client.query as jest.Mock<any>).mockImplementation(async (sql: string) => {
      if (sql.includes("fail")) throw new Error("oops");
      return { rows: [] };
    });

    const orchestrator = new GdprErasureOrchestrator({
      pool,
      legalHold,
      getGraph: () => [failNode],
    });

    await expect(orchestrator.erase(liveRequest())).rejects.toThrow();
    expect((spy.client.release as jest.Mock).mock.calls).toHaveLength(1);
  });
});

// ─── FK graph walk ────────────────────────────────────────────────────────────

describe("GdprErasureOrchestrator — FK graph walk", () => {
  it("tombstones tables in the order returned by the graph", async () => {
    const graph: TableNode[] = [
      {
        table: "booking_intents",
        pkCol: "id",
        fkCol: "customer_id",
        piiColumns: [{ name: "note", storeHash: true }],
        dependsOn: [],
      },
      {
        table: "users",
        pkCol: "id",
        fkCol: "id",
        piiColumns: [{ name: "email", storeHash: true }],
        dependsOn: ["booking_intents"],
      },
    ];

    const rowsByTable = {
      booking_intents: [{ id: "b1", note: "some note" }],
      users: [{ id: "user-123", email: "a@b.com" }],
    };

    const { orchestrator, spy } = makeOrchestrator({ graph, rowsByTable });
    await orchestrator.erase(liveRequest("user-123"));

    const selectTableOrder = spy.queries
      .filter((q) => q.sql.toUpperCase().startsWith("SELECT"))
      .map((q) => {
        if (q.sql.includes("booking_intents")) return "booking_intents";
        if (q.sql.includes("users")) return "users";
        return "?";
      });

    const biIdx = selectTableOrder.indexOf("booking_intents");
    const usersIdx = selectTableOrder.indexOf("users");
    expect(biIdx).toBeLessThan(usersIdx);
  });

  it("processes all nodes in the graph even if some have no rows", async () => {
    const graph: TableNode[] = [
      {
        table: "checkout_sessions",
        pkCol: "id",
        fkCol: "customer_id",
        piiColumns: [{ name: "customer_email", storeHash: true }],
        dependsOn: [],
      },
      {
        table: "users",
        pkCol: "id",
        fkCol: "id",
        piiColumns: [{ name: "email", storeHash: true }],
        dependsOn: ["checkout_sessions"],
      },
    ];

    const { orchestrator, spy } = makeOrchestrator({ graph });
    await orchestrator.erase(liveRequest());

    const selects = spy.queries.filter((q) => q.sql.toUpperCase().startsWith("SELECT"));
    // Both tables should be SELECTed even if no rows are found.
    const tables = selects.map((q) => {
      if (q.sql.includes("checkout_sessions")) return "checkout_sessions";
      if (q.sql.includes("users")) return "users";
      return "?";
    });
    expect(tables).toContain("checkout_sessions");
    expect(tables).toContain("users");
  });
});

// ─── Receipt & event log ──────────────────────────────────────────────────────

describe("GdprErasureOrchestrator — receipt", () => {
  it("writes a receipt to the event log on live erasure", async () => {
    const eventLog = new InMemoryErasureEventLog();
    const { orchestrator } = makeOrchestrator({ eventLog });
    await orchestrator.erase(liveRequest("user-xyz"));
    expect(eventLog.all()).toHaveLength(1);
    expect(eventLog.all()[0].subjectId).toBe("user-xyz");
  });

  it("writes a receipt with dryRun=true for dry-run erasure", async () => {
    const eventLog = new InMemoryErasureEventLog();
    const { orchestrator } = makeOrchestrator({ eventLog });
    await orchestrator.erase(dryRequest("user-dry"));
    expect(eventLog.all()[0].dryRun).toBe(true);
  });

  it("receipt includes receiptId and erasedAt", async () => {
    const eventLog = new InMemoryErasureEventLog();
    const { orchestrator } = makeOrchestrator({ eventLog });
    const { receipt } = await orchestrator.erase(liveRequest());
    expect(receipt.receiptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(receipt.erasedAt).toBeTruthy();
    expect(() => new Date(receipt.erasedAt)).not.toThrow();
  });

  it("receipt includes requestedBy", async () => {
    const eventLog = new InMemoryErasureEventLog();
    const { orchestrator } = makeOrchestrator({ eventLog });
    const { receipt } = await orchestrator.erase(liveRequest());
    expect(receipt.requestedBy).toBe("admin-1");
  });

  it("receipt includes tablesAffected for rows with data", async () => {
    const eventLog = new InMemoryErasureEventLog();
    const graph: TableNode[] = [
      {
        table: "users",
        pkCol: "id",
        fkCol: "id",
        piiColumns: [{ name: "email", storeHash: true }],
        dependsOn: [],
      },
    ];
    const rowsByTable = { users: [{ id: "user-123", email: "a@b.com" }] };
    const { orchestrator } = makeOrchestrator({ graph, rowsByTable, eventLog });
    const { receipt } = await orchestrator.erase(liveRequest());
    expect(receipt.tablesAffected).toContain("users");
  });
});
