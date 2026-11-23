import { jest } from "@jest/globals";
import {
  InMemoryOutboxStore,
  OutboxRow,
  compactOutboxOnce,
  runOutboxCompactionWorker,
} from "../scheduler/outboxCompactionWorker.js";
import { register } from "../metrics.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(
  id: string,
  ackedAt: Date | null,
  createdAt?: Date,
): OutboxRow {
  return {
    id,
    event_type: "test.event",
    aggregate_id: `agg-${id}`,
    payload: { data: id },
    created_at: createdAt ?? new Date(),
    acked_at: ackedAt,
  };
}

async function metricValue(metricName: string): Promise<number> {
  const text = await register.metrics();
  const line = text
    .split("\n")
    .find((l) => l.startsWith(metricName) && !l.startsWith("#"));
  if (!line) return 0;
  const parts = line.trim().split(/\s+/);
  return Number(parts[parts.length - 1]);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_TIME = 1_700_000_000_000; // fixed epoch for determinism
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

describe("outbox compaction worker", () => {
  let store: InMemoryOutboxStore;

  beforeEach(() => {
    store = new InMemoryOutboxStore();
    register.resetMetrics();
    jest.useFakeTimers().setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Basic happy-path ──────────────────────────────────────────────────────

  it("deletes acked rows older than the retention window", () => {
    // acked 8 days ago — eligible
    const old = makeRow("r1", new Date(BASE_TIME - SEVEN_DAYS_MS - 1));
    // acked 6 days ago — NOT yet eligible
    const recent = makeRow("r2", new Date(BASE_TIME - SEVEN_DAYS_MS + 1_000));
    // never acked — NOT eligible
    const unacked = makeRow("r3", null);

    store.upsert(old);
    store.upsert(recent);
    store.upsert(unacked);

    const result = compactOutboxOnce(store, {}, BASE_TIME);

    expect(result.deleted).toBe(1);
    expect(result.skippedBecauseThreshold).toBeUndefined();
    expect(store.size()).toBe(2);
    expect(store.list().map((r) => r.id)).toEqual(
      expect.arrayContaining(["r2", "r3"]),
    );
  });

  it("does nothing when no rows are eligible", () => {
    store.upsert(makeRow("r1", null));
    store.upsert(makeRow("r2", new Date(BASE_TIME - 1_000)));

    const result = compactOutboxOnce(store, {}, BASE_TIME);

    expect(result.deleted).toBe(0);
    expect(store.size()).toBe(2);
  });

  it("deletes all eligible rows when count is below batchSize", () => {
    for (let i = 0; i < 10; i++) {
      store.upsert(makeRow(`r${i}`, new Date(BASE_TIME - SEVEN_DAYS_MS - 1)));
    }

    const result = compactOutboxOnce(store, { batchSize: 100 }, BASE_TIME);

    expect(result.deleted).toBe(10);
    expect(store.size()).toBe(0);
  });

  // ── Ack loss (un-acked rows must survive compaction) ──────────────────────

  it("never deletes un-acked rows regardless of age", () => {
    // An old un-acked row — e.g. downstream ack was lost.
    const lostAck = makeRow(
      "lost",
      null,
      new Date(BASE_TIME - 30 * 24 * 60 * 60 * 1_000), // 30 days old
    );
    store.upsert(lostAck);

    const result = compactOutboxOnce(
      store,
      { retentionMs: 1 }, // extremely short window — still must not touch un-acked
      BASE_TIME,
    );

    expect(result.deleted).toBe(0);
    expect(store.size()).toBe(1);
    expect(store.list()[0].id).toBe("lost");
  });

  it("keeps rows whose acked_at is exactly at the retention boundary", () => {
    // acked_at == (now - retentionMs) is the exact cutoff.
    // With strict less-than the boundary row must NOT be deleted.
    const boundary = makeRow(
      "boundary",
      new Date(BASE_TIME - SEVEN_DAYS_MS), // exactly at cutoff
    );
    store.upsert(boundary);

    const result = compactOutboxOnce(store, {}, BASE_TIME);

    expect(result.deleted).toBe(0);
    expect(store.size()).toBe(1);
  });

  // ── Retention window change mid-run ───────────────────────────────────────

  it("respects a shorter retention window injected at runtime", () => {
    const ONE_HOUR_MS = 60 * 60 * 1_000;
    // acked 2 hours ago
    const row = makeRow("r1", new Date(BASE_TIME - 2 * ONE_HOUR_MS));
    store.upsert(row);

    // With default 7-day window: not eligible
    const defaultResult = compactOutboxOnce(store, {}, BASE_TIME);
    expect(defaultResult.deleted).toBe(0);

    // Override to 1 hour: now eligible
    const shortResult = compactOutboxOnce(
      store,
      { retentionMs: ONE_HOUR_MS },
      BASE_TIME,
    );
    expect(shortResult.deleted).toBe(1);
    expect(store.size()).toBe(0);
  });

  it("respects a longer retention window injected at runtime", () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
    // acked 10 days ago — would be eligible under default 7-day window
    const row = makeRow("r1", new Date(BASE_TIME - 10 * 24 * 60 * 60 * 1_000));
    store.upsert(row);

    const result = compactOutboxOnce(
      store,
      { retentionMs: THIRTY_DAYS_MS },
      BASE_TIME,
    );
    expect(result.deleted).toBe(0);
    expect(store.size()).toBe(1);
  });

  // ── Compaction stall / safety threshold ──────────────────────────────────

  it("triggers the safety brake and skips deletion when candidates exceed threshold", async () => {
    for (let i = 0; i < 15; i++) {
      store.upsert(makeRow(`r${i}`, new Date(BASE_TIME - SEVEN_DAYS_MS - 1)));
    }

    const result = compactOutboxOnce(
      store,
      { safetyThreshold: 10 },
      BASE_TIME,
    );

    expect(result.deleted).toBe(0);
    expect(result.skippedBecauseThreshold).toBe(true);
    expect(store.size()).toBe(15); // nothing removed
    expect(
      await metricValue("outbox_compaction_safety_brake_triggers_total"),
    ).toBe(1);
  });

  it("allows deletion when candidates are exactly at the safety threshold", () => {
    // threshold = 5, candidates = 5 → should proceed
    for (let i = 0; i < 5; i++) {
      store.upsert(makeRow(`r${i}`, new Date(BASE_TIME - SEVEN_DAYS_MS - 1)));
    }

    const result = compactOutboxOnce(
      store,
      { safetyThreshold: 5 },
      BASE_TIME,
    );

    expect(result.skippedBecauseThreshold).toBeUndefined();
    expect(result.deleted).toBe(5);
  });

  // ── Batch size cap ────────────────────────────────────────────────────────

  it("respects the batchSize cap and leaves remaining eligible rows untouched", () => {
    for (let i = 0; i < 10; i++) {
      store.upsert(makeRow(`r${i}`, new Date(BASE_TIME - SEVEN_DAYS_MS - 1)));
    }

    const result = compactOutboxOnce(store, { batchSize: 3 }, BASE_TIME);

    expect(result.deleted).toBe(3);
    expect(store.size()).toBe(7);
  });

  // ── Metric assertions ─────────────────────────────────────────────────────

  it("increments rows_deleted_total metric for each compacted row", async () => {
    store.upsert(makeRow("m1", new Date(BASE_TIME - SEVEN_DAYS_MS - 1)));
    store.upsert(makeRow("m2", new Date(BASE_TIME - SEVEN_DAYS_MS - 1)));

    compactOutboxOnce(store, {}, BASE_TIME);

    expect(
      await metricValue("outbox_compaction_rows_deleted_total"),
    ).toBe(2);
  });

  it("does not increment rows_deleted_total when nothing was deleted", async () => {
    store.upsert(makeRow("u1", null));

    compactOutboxOnce(store, {}, BASE_TIME);

    expect(
      await metricValue("outbox_compaction_rows_deleted_total"),
    ).toBe(0);
  });

  it("records a duration histogram observation for every sweep", async () => {
    store.upsert(makeRow("d1", new Date(BASE_TIME - SEVEN_DAYS_MS - 1)));

    compactOutboxOnce(store, {}, BASE_TIME);

    const text = await register.metrics();
    // histogram _count should be 1 after one sweep
    const countLine = text
      .split("\n")
      .find((l) => l.startsWith("outbox_compaction_duration_ms_count"));
    expect(countLine).toBeDefined();
    expect(Number(countLine!.trim().split(/\s+/).at(-1))).toBe(1);
  });

  it("records a histogram observation even when no rows were eligible", async () => {
    compactOutboxOnce(store, {}, BASE_TIME); // empty store

    const text = await register.metrics();
    const countLine = text
      .split("\n")
      .find((l) => l.startsWith("outbox_compaction_duration_ms_count"));
    expect(countLine).toBeDefined();
    expect(Number(countLine!.trim().split(/\s+/).at(-1))).toBe(1);
  });

  // ── Worker loop lifecycle ─────────────────────────────────────────────────

  it("runs multiple sweeps and stops cleanly when aborted", async () => {
    // Seed a row that will be compacted on first sweep
    store.upsert(makeRow("w1", new Date(BASE_TIME - SEVEN_DAYS_MS - 1)));

    const controller = new AbortController();
    const workerPromise = runOutboxCompactionWorker(
      controller.signal,
      store,
      { intervalMs: 1_000 },
    );

    // Allow the first synchronous sweep to execute
    await Promise.resolve();
    controller.abort();
    await expect(workerPromise).resolves.toBeUndefined();

    expect(store.size()).toBe(0);
  });

  it("resolves immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runOutboxCompactionWorker(controller.signal, store, {}),
    ).resolves.toBeUndefined();
  });
});
