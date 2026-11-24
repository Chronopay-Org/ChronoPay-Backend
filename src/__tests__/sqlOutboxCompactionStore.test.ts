import { jest } from "@jest/globals";
import { Pool } from "pg";
import {
  SqlOutboxCompactionStore,
  compactOutboxOnce,
  runOutboxCompactionWorker,
} from "../scheduler/outboxCompactionWorker.js";
import { register } from "../metrics.js";

async function metricValue(metricName: string): Promise<number> {
  const text = await register.metrics();
  const line = text
    .split("\n")
    .find((l) => l.startsWith(metricName) && !l.startsWith("#"));
  if (!line) return 0;
  const parts = line.trim().split(/\s+/);
  return Number(parts[parts.length - 1]);
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

describe("SqlOutboxCompactionStore", () => {
  let pool: Pool;
  let querySpy: jest.SpiedFunction<Pool["query"]>;
  let store: SqlOutboxCompactionStore;

  beforeEach(() => {
    pool = new Pool();
    querySpy = jest.spyOn(pool, "query");
    store = new SqlOutboxCompactionStore(pool);
    register.resetMetrics();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── countCandidates ────────────────────────────────────────────────────────

  it("counts acked rows older than retention and never includes unacked rows", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [{ count: "42" }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    } as never);

    const count = await store.countCandidates(SEVEN_DAYS_MS);

    expect(count).toBe(42);
    expect(querySpy).toHaveBeenCalledTimes(1);
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SELECT\s+COUNT\(\*\)/i);
    expect(sql).toMatch(/FROM\s+outbox_events/i);
    expect(sql).toMatch(/acked_at\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/acked_at\s*<\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s+'1 millisecond'\)/i);
    expect(params).toEqual([SEVEN_DAYS_MS]);
  });

  it("returns 0 when count query returns no rows", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: "SELECT",
      oid: 0,
      fields: [],
    } as never);

    const count = await store.countCandidates(SEVEN_DAYS_MS);

    expect(count).toBe(0);
  });

  // ── deleteBatch ────────────────────────────────────────────────────────────

  it("deletes acked rows older than retention in bounded batches via subquery", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [],
      rowCount: 25,
      command: "DELETE",
      oid: 0,
      fields: [],
    } as never);

    const deleted = await store.deleteBatch(SEVEN_DAYS_MS, 100);

    expect(deleted).toBe(25);
    expect(querySpy).toHaveBeenCalledTimes(1);
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE\s+FROM\s+outbox_events/i);
    expect(sql).toMatch(/WHERE\s+id\s+IN\s*\(\s*SELECT\s+id/i);
    expect(sql).toMatch(/acked_at\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/acked_at\s*<\s*NOW\(\)\s*-\s*\(\$1\s*\*\s*INTERVAL\s+'1 millisecond'\)/i);
    expect(sql).toMatch(/LIMIT\s+\$2/i);
    expect(params).toEqual([SEVEN_DAYS_MS, 100]);
  });

  it("returns 0 when rowCount is null", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [],
      rowCount: null,
      command: "DELETE",
      oid: 0,
      fields: [],
    } as never);

    const deleted = await store.deleteBatch(SEVEN_DAYS_MS, 50);

    expect(deleted).toBe(0);
  });

  // ── compactOutboxOnce integration ──────────────────────────────────────────

  it("counts candidates first and deletes a batch when within safety threshold", async () => {
    querySpy
      .mockResolvedValueOnce({
        rows: [{ count: "12" }],
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      } as never)
      .mockResolvedValueOnce({
        rows: [],
        rowCount: 5,
        command: "DELETE",
        oid: 0,
        fields: [],
      } as never);

    const result = await compactOutboxOnce(store, {
      retentionMs: SEVEN_DAYS_MS,
      batchSize: 5,
      safetyThreshold: 20,
    });

    expect(result).toEqual({ deleted: 5 });
    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(await metricValue("outbox_compaction_rows_deleted_total")).toBe(5);
  });

  it("deletes nothing and triggers safety brake when candidate count exceeds threshold", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [{ count: "10001" }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    } as never);

    const result = await compactOutboxOnce(store, {
      safetyThreshold: 10_000,
    });

    expect(result).toEqual({ deleted: 0, skippedBecauseThreshold: true });
    // Only the COUNT query ran; DELETE was never issued.
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(
      await metricValue("outbox_compaction_safety_brake_triggers_total"),
    ).toBe(1);
    expect(await metricValue("outbox_compaction_rows_deleted_total")).toBe(0);
  });

  it("skips DELETE when candidate count is 0", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [{ count: "0" }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    } as never);

    const result = await compactOutboxOnce(store, {});

    expect(result).toEqual({ deleted: 0 });
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it("proceeds with deletion when candidate count equals safety threshold", async () => {
    querySpy
      .mockResolvedValueOnce({
        rows: [{ count: "10" }],
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      } as never)
      .mockResolvedValueOnce({
        rows: [],
        rowCount: 10,
        command: "DELETE",
        oid: 0,
        fields: [],
      } as never);

    const result = await compactOutboxOnce(store, {
      safetyThreshold: 10,
      batchSize: 10,
    });

    expect(result).toEqual({ deleted: 10 });
    expect(querySpy).toHaveBeenCalledTimes(2);
  });

  // ── runOutboxCompactionWorker integration ──────────────────────────────────

  it("runs compaction sweeps against the SQL store and stops cleanly on abort", async () => {
    querySpy
      .mockResolvedValueOnce({
        rows: [{ count: "3" }],
        rowCount: 1,
        command: "SELECT",
        oid: 0,
        fields: [],
      } as never)
      .mockResolvedValueOnce({
        rows: [],
        rowCount: 3,
        command: "DELETE",
        oid: 0,
        fields: [],
      } as never);

    const controller = new AbortController();
    const workerPromise = runOutboxCompactionWorker(controller.signal, store, {
      intervalMs: 60_000,
    });

    // Wait a tick for the first async sweep to finish before aborting.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(workerPromise).resolves.toBeUndefined();
    expect(querySpy).toHaveBeenCalledTimes(2);
  });
});
