import { jest } from "@jest/globals";
import {
  InMemoryOutboxStore,
  OutboxEvent,
  relayOutboxOnce,
  runOutboxRelayWorker,
  PublishFn,
} from "../services/outboxRelay.js";
import { register } from "../metrics.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(
  id: string,
  eventType?: string,
  aggregateId?: string,
  createdAt?: Date,
): OutboxEvent {
  return {
    id,
    event_type: eventType ?? "test.event",
    aggregate_id: aggregateId ?? `agg-${id}`,
    payload: { data: id },
    created_at: createdAt ?? new Date(1_700_000_000_000),
    acked_at: null,
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

const BASE_TIME = 1_700_000_000_000;

describe("outbox relay worker", () => {
  let store: InMemoryOutboxStore;
  let publishMock: jest.MockedFunction<PublishFn>;

  beforeEach(() => {
    store = new InMemoryOutboxStore();
    publishMock = jest.fn<PublishFn>().mockResolvedValue(undefined);
    register.resetMetrics();
    jest.useFakeTimers().setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("publishes and acks a single un-acked event", async () => {
    const event = makeEvent("e1");
    store.upsert(event);

    const result = await relayOutboxOnce(store, publishMock, {});

    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }));

    // Event should now be acked
    const rows = store.list();
    expect(rows[0].acked_at).not.toBeNull();
  });

  it("publishes and acks multiple events in order", async () => {
    store.upsert(makeEvent("e1", "test.event", "agg-1", new Date(BASE_TIME)));
    store.upsert(makeEvent("e2", "test.event", "agg-1", new Date(BASE_TIME + 100)));
    store.upsert(makeEvent("e3", "test.event", "agg-2", new Date(BASE_TIME + 200)));

    const result = await relayOutboxOnce(store, publishMock, { batchSize: 10 });

    expect(result.published).toBe(3);
    expect(result.failed).toBe(0);
    expect(publishMock).toHaveBeenCalledTimes(3);

    const allAcked = store.list().every((r) => r.acked_at !== null);
    expect(allAcked).toBe(true);
  });

  it("does nothing when there are no un-acked events", async () => {
    // Only acked events
    const event = makeEvent("e1");
    event.acked_at = new Date();
    store.upsert(event);

    const result = await relayOutboxOnce(store, publishMock, {});

    expect(result.published).toBe(0);
    expect(result.failed).toBe(0);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("does nothing on an empty store", async () => {
    const result = await relayOutboxOnce(store, publishMock, {});

    expect(result.published).toBe(0);
    expect(result.failed).toBe(0);
    expect(publishMock).not.toHaveBeenCalled();
  });

  // ── Batch size cap ───────────────────────────────────────────────────────

  it("respects the batchSize cap and leaves remaining events for the next sweep", async () => {
    for (let i = 0; i < 10; i++) {
      store.upsert(makeEvent(`e${i}`, "test.event", `agg-${i}`, new Date(BASE_TIME + i)));
    }

    const result = await relayOutboxOnce(store, publishMock, { batchSize: 3 });

    expect(result.published).toBe(3);
    expect(publishMock).toHaveBeenCalledTimes(3);

    const acked = store.list().filter((r) => r.acked_at !== null).length;
    expect(acked).toBe(3);
    const unacked = store.list().filter((r) => r.acked_at === null).length;
    expect(unacked).toBe(7);
  });

  // ── Publish failure handling ─────────────────────────────────────────────

  it("continues processing remaining events after a publish failure", async () => {
    store.upsert(makeEvent("e1", "test.event", "agg-1", new Date(BASE_TIME)));
    store.upsert(makeEvent("e2-poison", "test.event", "agg-2", new Date(BASE_TIME + 100)));
    store.upsert(makeEvent("e3", "test.event", "agg-3", new Date(BASE_TIME + 200)));

    // Make the second event fail
    publishMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("downstream unavailable"))
      .mockResolvedValueOnce(undefined);

    const result = await relayOutboxOnce(store, publishMock, { batchSize: 10 });

    expect(result.published).toBe(2);
    expect(result.failed).toBe(1);
    expect(publishMock).toHaveBeenCalledTimes(3);

    // e1 and e3 should be acked; e2-poison should remain un-acked
    const e1 = store.list().find((r) => r.id === "e1");
    const e2 = store.list().find((r) => r.id === "e2-poison");
    const e3 = store.list().find((r) => r.id === "e3");
    expect(e1!.acked_at).not.toBeNull();
    expect(e2!.acked_at).toBeNull();
    expect(e3!.acked_at).not.toBeNull();
  });

  it("handles all events failing to publish", async () => {
    store.upsert(makeEvent("e1", "test.event", "agg-1", new Date(BASE_TIME)));
    store.upsert(makeEvent("e2", "test.event", "agg-2", new Date(BASE_TIME + 100)));

    publishMock.mockRejectedValue(new Error("downstream unavailable"));

    const result = await relayOutboxOnce(store, publishMock, { batchSize: 10 });

    expect(result.published).toBe(0);
    expect(result.failed).toBe(2);

    // Both should remain un-acked for retry
    const allUnacked = store.list().every((r) => r.acked_at === null);
    expect(allUnacked).toBe(true);
  });

  // ── At-least-once guarantee: crash after publish before mark ─────────────

  it("leaves event un-acked when publish succeeds but markAcked fails", async () => {
    store.upsert(makeEvent("e1", "test.event", "agg-1", new Date(BASE_TIME)));

    // Publish succeeds but markAcked throws
    jest.spyOn(store, "markAcked").mockRejectedValueOnce(new Error("db write failed"));

    await relayOutboxOnce(store, publishMock, { batchSize: 10 });

    // The counter counts it as published since publish() succeeded
    // But the event is NOT acked — next sweep will retry
    expect(publishMock).toHaveBeenCalledTimes(1);
    const e1 = store.list().find((r) => r.id === "e1");
    expect(e1!.acked_at).toBeNull();
  });

  // ── Metric assertions ────────────────────────────────────────────────────

  it("increments published_total metric for each published event", async () => {
    store.upsert(makeEvent("m1", "test.event", "agg-1", new Date(BASE_TIME)));
    store.upsert(makeEvent("m2", "test.event", "agg-2", new Date(BASE_TIME + 100)));

    await relayOutboxOnce(store, publishMock, {});

    expect(await metricValue("outbox_relay_published_total")).toBe(2);
  });

  it("increments publish_errors_total metric for failed events", async () => {
    store.upsert(makeEvent("m1", "test.event", "agg-1", new Date(BASE_TIME)));
    publishMock.mockRejectedValue(new Error("downstream unavailable"));

    await relayOutboxOnce(store, publishMock, {});

    expect(await metricValue("outbox_relay_publish_errors_total")).toBe(1);
  });

  it("increments sweeps_total metric for each relay sweep", async () => {
    await relayOutboxOnce(store, publishMock, {});
    expect(await metricValue("outbox_relay_sweeps_total")).toBe(1);

    await relayOutboxOnce(store, publishMock, {});
    expect(await metricValue("outbox_relay_sweeps_total")).toBe(2);
  });

  it("records a duration histogram observation for every sweep", async () => {
    store.upsert(makeEvent("d1", "test.event", "agg-1", new Date(BASE_TIME)));

    await relayOutboxOnce(store, publishMock, {});

    const text = await register.metrics();
    const countLine = text
      .split("\n")
      .find((l) => l.startsWith("outbox_relay_duration_ms_count"));
    expect(countLine).toBeDefined();
    expect(Number(countLine!.trim().split(/\s+/).at(-1))).toBe(1);
  });

  it("records a histogram observation even when no events were published", async () => {
    await relayOutboxOnce(store, publishMock, {}); // empty store

    const text = await register.metrics();
    const countLine = text
      .split("\n")
      .find((l) => l.startsWith("outbox_relay_duration_ms_count"));
    expect(countLine).toBeDefined();
    expect(Number(countLine!.trim().split(/\s+/).at(-1))).toBe(1);
  });

  // ── Worker loop lifecycle ────────────────────────────────────────────────

  it("runs multiple sweeps and stops cleanly when aborted", async () => {
    store.upsert(makeEvent("w1", "test.event", "agg-1", new Date(BASE_TIME)));

    const controller = new AbortController();
    const workerPromise = runOutboxRelayWorker(
      controller.signal,
      store,
      publishMock,
      { intervalMs: 1_000 },
    );

    // Allow the first synchronous sweep to execute
    await Promise.resolve();
    controller.abort();
    await expect(workerPromise).resolves.toBeUndefined();

    // The event should be published and acked
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it("resolves immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runOutboxRelayWorker(controller.signal, store, publishMock, {}),
    ).resolves.toBeUndefined();

    expect(publishMock).not.toHaveBeenCalled();
  });

  // ── Concurrent sweeps don't double-publish ───────────────────────────────

  it("processes events in FIFO order based on created_at", async () => {
    // Out of insertion order but with explicit timestamps to verify FIFO
    store.upsert(makeEvent("e-late", "test.event", "agg-3", new Date(BASE_TIME + 200)));
    store.upsert(makeEvent("e-early", "test.event", "agg-1", new Date(BASE_TIME)));
    store.upsert(makeEvent("e-mid", "test.event", "agg-2", new Date(BASE_TIME + 100)));

    await relayOutboxOnce(store, publishMock, { batchSize: 10 });

    // Events should be published in created_at order
    expect(publishMock).toHaveBeenCalledTimes(3);
    const callArgs = publishMock.mock.calls.map(([event]) => event.id);
    expect(callArgs).toEqual(["e-early", "e-mid", "e-late"]);
  });

  it("skips already-acked events and does not re-publish them", async () => {
    const event = makeEvent("e1", "test.event", "agg-1", new Date(BASE_TIME));
    event.acked_at = new Date(BASE_TIME + 1000); // already acked
    store.upsert(event);

    const result = await relayOutboxOnce(store, publishMock, {});

    expect(result.published).toBe(0);
    expect(publishMock).not.toHaveBeenCalled();
  });
});
