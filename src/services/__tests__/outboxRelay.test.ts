import { jest } from "@jest/globals";
import type { Pool } from "pg";
import {
  InMemoryOutboxStore,
  OUTBOX_CLAIM_LEASE_MS,
  OutboxEvent,
  relayOutboxOnce,
  SqlOutboxStore,
} from "../outboxRelay.js";

function makeEvent(id: string, createdAt: number): OutboxEvent {
  return {
    id,
    event_type: "test.event",
    aggregate_id: `aggregate-${id}`,
    payload: { id },
    created_at: new Date(createdAt),
    acked_at: null,
  };
}

describe("outbox event claims", () => {
  it("claims SQL rows with one atomic UPDATE containing the locking selection", async () => {
    const query = jest.fn<Pool["query"]>().mockResolvedValue({
      rows: [],
      command: "UPDATE",
      rowCount: 0,
      oid: 0,
      fields: [],
    });
    const store = new SqlOutboxStore({
      query,
    } as unknown as Pick<Pool, "query">);

    await store.fetchUnacked(12);

    expect(query).toHaveBeenCalledTimes(1);
    const [statement, values] = query.mock.calls[0];
    expect(statement).toContain("UPDATE outbox_events AS events");
    expect(statement).toContain("FOR UPDATE SKIP LOCKED");
    expect(statement).toContain("claimed_until <= NOW()");
    expect(values).toEqual([12, OUTBOX_CLAIM_LEASE_MS]);
  });

  it("does not publish the same event from concurrent workers", async () => {
    const store = new InMemoryOutboxStore();
    for (let i = 0; i < 4; i += 1) {
      store.upsert(makeEvent(`event-${i}`, i));
    }
    const publishedIds: string[] = [];
    const publish = jest.fn(async (event: OutboxEvent) => {
      publishedIds.push(event.id);
    });

    await Promise.all([
      relayOutboxOnce(store, publish, { batchSize: 2 }),
      relayOutboxOnce(store, publish, { batchSize: 2 }),
    ]);

    expect(publishedIds).toHaveLength(4);
    expect(new Set(publishedIds).size).toBe(4);
    expect(publishedIds.sort()).toEqual([
      "event-0",
      "event-1",
      "event-2",
      "event-3",
    ]);
  });

  it("makes a claim available again after its lease expires", async () => {
    jest.useFakeTimers().setSystemTime(1_700_000_000_000);
    try {
      const store = new InMemoryOutboxStore(1_000);
      store.upsert(makeEvent("recoverable", Date.now()));

      expect(await store.fetchUnacked(1)).toHaveLength(1);
      expect(await store.fetchUnacked(1)).toHaveLength(0);

      jest.advanceTimersByTime(1_000);
      expect(await store.fetchUnacked(1)).toEqual([
        expect.objectContaining({ id: "recoverable" }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });
});
