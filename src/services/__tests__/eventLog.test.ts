/**
 * eventLog.test.ts
 *
 * Unit tests for the GDPR erasure event log.
 * Tests the InMemoryErasureEventLog and the PgErasureEventLog (with mock DB).
 */

import { jest } from "@jest/globals";
import {
  InMemoryErasureEventLog,
  PgErasureEventLog,
  type ErasureReceipt,
} from "../../services/gdprErasure/eventLog.js";
import type { PoolClient } from "pg";

// ─── Receipt factory ──────────────────────────────────────────────────────────

function makeReceipt(overrides: Partial<ErasureReceipt> = {}): ErasureReceipt {
  return {
    receiptId: "receipt-001",
    subjectId: "user-123",
    erasedAt: new Date().toISOString(),
    tablesAffected: [{ table: "users", rowsAffected: 1 }],
    totalRowsAffected: 1,
    dryRun: false,
    requestedBy: "admin-456",
    ...overrides,
  };
}

// ─── InMemoryErasureEventLog ──────────────────────────────────────────────────

describe("InMemoryErasureEventLog", () => {
  let log: InMemoryErasureEventLog;

  beforeEach(() => {
    log = new InMemoryErasureEventLog();
  });

  it("stores a receipt and retrieves it by subjectId", async () => {
    const receipt = makeReceipt({ subjectId: "user-1" });
    await log.writeReceipt(receipt);

    const results = await log.getReceiptsForSubject("user-1");
    expect(results).toHaveLength(1);
    expect(results[0].receiptId).toBe("receipt-001");
  });

  it("returns empty array for unknown subjectId", async () => {
    const results = await log.getReceiptsForSubject("nonexistent");
    expect(results).toHaveLength(0);
  });

  it("returns only receipts matching the requested subjectId", async () => {
    await log.writeReceipt(makeReceipt({ subjectId: "user-A", receiptId: "r1" }));
    await log.writeReceipt(makeReceipt({ subjectId: "user-B", receiptId: "r2" }));

    const resultsA = await log.getReceiptsForSubject("user-A");
    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].receiptId).toBe("r1");
  });

  it("returns multiple receipts for the same subject", async () => {
    await log.writeReceipt(makeReceipt({ receiptId: "r1", erasedAt: "2024-01-01T00:00:00Z" }));
    await log.writeReceipt(makeReceipt({ receiptId: "r2", erasedAt: "2024-06-01T00:00:00Z" }));

    const results = await log.getReceiptsForSubject("user-123");
    expect(results).toHaveLength(2);
  });

  it("returns receipts sorted descending by erasedAt", async () => {
    await log.writeReceipt(makeReceipt({ receiptId: "r1", erasedAt: "2024-01-01T00:00:00Z" }));
    await log.writeReceipt(makeReceipt({ receiptId: "r2", erasedAt: "2024-12-01T00:00:00Z" }));
    await log.writeReceipt(makeReceipt({ receiptId: "r3", erasedAt: "2024-06-01T00:00:00Z" }));

    const results = await log.getReceiptsForSubject("user-123");
    expect(results[0].receiptId).toBe("r2"); // most recent first
    expect(results[1].receiptId).toBe("r3");
    expect(results[2].receiptId).toBe("r1");
  });

  it("stores a copy (mutating the original does not affect the stored receipt)", async () => {
    const receipt = makeReceipt();
    await log.writeReceipt(receipt);

    // Mutate original after storing
    receipt.subjectId = "tampered";

    const stored = await log.getReceiptsForSubject("user-123");
    expect(stored[0].subjectId).toBe("user-123");
  });

  it("clear() removes all receipts", async () => {
    await log.writeReceipt(makeReceipt({ receiptId: "r1" }));
    await log.writeReceipt(makeReceipt({ receiptId: "r2" }));
    log.clear();
    const results = await log.getReceiptsForSubject("user-123");
    expect(results).toHaveLength(0);
  });

  it("all() returns a snapshot of all receipts", async () => {
    await log.writeReceipt(makeReceipt({ receiptId: "r1" }));
    await log.writeReceipt(makeReceipt({ receiptId: "r2" }));
    expect(log.all()).toHaveLength(2);
  });

  it("stores dry-run receipts", async () => {
    await log.writeReceipt(makeReceipt({ dryRun: true, receiptId: "dry-r1" }));
    const results = await log.getReceiptsForSubject("user-123");
    expect(results[0].dryRun).toBe(true);
  });
});

// ─── PgErasureEventLog ────────────────────────────────────────────────────────

describe("PgErasureEventLog", () => {
  function makeFakeClient(rows: unknown[] = []): {
    client: PoolClient;
    calls: Array<{ sql: string; params: unknown[] }>;
  } {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows };
      }),
    } as unknown as PoolClient;
    return { client, calls };
  }

  it("writeReceipt inserts into gdpr_erasure_events with correct params", async () => {
    const { client, calls } = makeFakeClient();
    const pgLog = new PgErasureEventLog(client);
    const receipt = makeReceipt();

    await pgLog.writeReceipt(receipt);

    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0];
    expect(sql).toContain("INSERT INTO gdpr_erasure_events");
    expect(params).toContain(receipt.receiptId);
    expect(params).toContain(receipt.subjectId);
    expect(params).toContain(receipt.erasedAt);
    expect(params).toContain(receipt.dryRun);
    expect(params).toContain(receipt.requestedBy);
  });

  it("writeReceipt stores full receipt JSON", async () => {
    const { client, calls } = makeFakeClient();
    const pgLog = new PgErasureEventLog(client);
    const receipt = makeReceipt();

    await pgLog.writeReceipt(receipt);

    const json = calls[0].params.find(
      (p) => typeof p === "string" && p.includes("receiptId"),
    ) as string;
    expect(json).toBeDefined();
    const parsed = JSON.parse(json);
    expect(parsed.receiptId).toBe(receipt.receiptId);
  });

  it("getReceiptsForSubject queries with correct subjectId", async () => {
    const receipt = makeReceipt();
    const { client, calls } = makeFakeClient([{ receipt }]);
    const pgLog = new PgErasureEventLog(client);

    await pgLog.getReceiptsForSubject("user-123");

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toContain("user-123");
    expect(calls[0].sql).toContain("SELECT");
    expect(calls[0].sql).toContain("gdpr_erasure_events");
  });

  it("getReceiptsForSubject maps receipt column from result rows", async () => {
    const receipt = makeReceipt();
    const { client } = makeFakeClient([{ receipt }]);
    const pgLog = new PgErasureEventLog(client);

    const results = await pgLog.getReceiptsForSubject("user-123");
    expect(results).toHaveLength(1);
    expect(results[0].receiptId).toBe(receipt.receiptId);
  });
});
