import { describe, it, expect, jest, afterEach } from "@jest/globals";
import http from "node:http";
import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import {
  HttpOutboxPublisher,
  LogOnlyOutboxPublisher,
  createOutboxPublisherFromEnv,
} from "../outboxPublisher.js";
import {
  InMemoryOutboxStore,
  SqlOutboxStore,
  relayOutboxOnce,
  type OutboxEvent,
} from "../outboxRelay.js";

function makeEvent(id = "evt-1"): OutboxEvent {
  return {
    id,
    event_type: "booking.confirmed",
    aggregate_id: "agg-123",
    payload: { bookingId: "agg-123", amount: 5000 },
    created_at: new Date("2026-01-15T12:00:00.000Z"),
    acked_at: null,
  };
}

interface RecordedRequest {
  method?: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
}

function startLocalServer(
  handler: (req: RecordedRequest, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        handler(
          {
            method: req.method,
            headers: req.headers,
            rawBody: Buffer.concat(chunks).toString("utf8"),
          },
          res,
        );
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Expected TCP address");
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/webhook`,
        close: () =>
          new Promise<void>((resClose, rejClose) =>
            server.close((err) => (err ? rejClose(err) : resClose())),
          ),
      });
    });
  });
}

describe("outboxPublisher", () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = undefined;
    }
    jest.useRealTimers();
  });

  it("delivers event with valid HMAC signature on 2xx and acks in relay", async () => {
    const received: RecordedRequest[] = [];
    const srv = await startLocalServer((req, res) => {
      received.push(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    closeServer = srv.close;

    const secret = "super-secret-signing-key";
    const publisher = new HttpOutboxPublisher({ url: srv.url, secret });
    const store = new InMemoryOutboxStore();
    store.upsert(makeEvent("evt-2xx"));

    const result = await relayOutboxOnce(store, (e) => publisher.publish(e));

    expect(result).toEqual({ published: 1, failed: 0 });
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("POST");
    expect(received[0].headers["x-outbox-event-id"]).toBe("evt-2xx");
    expect(received[0].headers["x-outbox-event-type"]).toBe("booking.confirmed");

    const expectedSig =
      "sha256=" + createHmac("sha256", secret).update(received[0].rawBody).digest("hex");
    expect(received[0].headers["x-webhook-signature"]).toBe(expectedSig);

    const parsed = JSON.parse(received[0].rawBody);
    expect(parsed).toEqual({
      id: "evt-2xx",
      eventType: "booking.confirmed",
      aggregateId: "agg-123",
      payload: { bookingId: "agg-123", amount: 5000 },
      createdAt: "2026-01-15T12:00:00.000Z",
    });

    const row = store.list()[0];
    expect(row.acked_at).not.toBeNull();
  });

  it("retries after 5xx honours claim lease and acks once endpoint returns 2xx", async () => {
    let callCount = 0;
    const srv = await startLocalServer((_req, res) => {
      callCount += 1;
      if (callCount === 1) {
        res.writeHead(503);
        res.end("service unavailable");
      } else {
        res.writeHead(202);
        res.end("accepted");
      }
    });
    closeServer = srv.close;

    const publisher = new HttpOutboxPublisher({ url: srv.url });
    const store = new InMemoryOutboxStore(50);
    store.upsert(makeEvent("evt-retry"));

    // First attempt: 503 -> fails, not acked, claim lease active
    const first = await relayOutboxOnce(store, (e) => publisher.publish(e), {
      maxAttempts: 3,
    });
    expect(first).toEqual({ published: 0, failed: 1 });
    expect(store.list()[0].acked_at).toBeNull();
    expect(store.list()[0].attempts).toBe(1);
    expect(store.list()[0].failed_at).toBeNull();

    // Immediately polling while lease is still active yields 0 events
    const duringLease = await relayOutboxOnce(store, (e) => publisher.publish(e), {
      maxAttempts: 3,
    });
    expect(duringLease).toEqual({ published: 0, failed: 0 });
    expect(callCount).toBe(1);

    // Wait for lease to expire, then retry -> 202 -> acked
    await new Promise((r) => setTimeout(r, 60));
    const second = await relayOutboxOnce(store, (e) => publisher.publish(e), {
      maxAttempts: 3,
    });
    expect(second).toEqual({ published: 1, failed: 0 });
    expect(callCount).toBe(2);
    expect(store.list()[0].acked_at).not.toBeNull();
  });

  it("marks event as permanently failed after exhausting maxAttempts", async () => {
    let callCount = 0;
    const srv = await startLocalServer((_req, res) => {
      callCount += 1;
      res.writeHead(500);
      res.end("boom");
    });
    closeServer = srv.close;

    const publisher = new HttpOutboxPublisher({ url: srv.url });
    const store = new InMemoryOutboxStore(10);
    store.upsert(makeEvent("evt-dlq"));

    // Attempt 1
    await relayOutboxOnce(store, (e) => publisher.publish(e), { maxAttempts: 2 });
    expect(store.list()[0].attempts).toBe(1);
    expect(store.list()[0].failed_at).toBeNull();

    // Wait for lease expiry, Attempt 2 -> hits maxAttempts=2 -> dead-lettered
    await new Promise((r) => setTimeout(r, 20));
    await relayOutboxOnce(store, (e) => publisher.publish(e), { maxAttempts: 2 });
    expect(store.list()[0].attempts).toBe(2);
    expect(store.list()[0].failed_at).not.toBeNull();
    expect(store.list()[0].last_error).toContain("Outbox webhook HTTP 500");

    // Subsequent poll must not pick up dead-lettered row
    await new Promise((r) => setTimeout(r, 20));
    const afterDlq = await relayOutboxOnce(store, (e) => publisher.publish(e), {
      maxAttempts: 2,
    });
    expect(afterDlq).toEqual({ published: 0, failed: 0 });
    expect(callCount).toBe(2);
  });

  it("throws on request timeout", async () => {
    const srv = await startLocalServer((_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200);
          res.end("late");
        }
      }, 200);
    });
    closeServer = srv.close;

    const publisher = new HttpOutboxPublisher({ url: srv.url, timeoutMs: 30 });
    await expect(publisher.publish(makeEvent("evt-timeout"))).rejects.toThrow(/timed out/i);
  });

  it("defaults to LogOnlyOutboxPublisher when OUTBOX_WEBHOOK_URL is unset", () => {
    expect(createOutboxPublisherFromEnv({})).toBeInstanceOf(LogOnlyOutboxPublisher);
    expect(
      createOutboxPublisherFromEnv({ OUTBOX_WEBHOOK_URL: "https://hooks.example.com/outbox" }),
    ).toBeInstanceOf(HttpOutboxPublisher);
  });

  it("SqlOutboxStore.recordFailure increments attempts and dead-letters on maxAttempts", async () => {
    const query = jest.fn<Pool["query"]>().mockResolvedValue({
      rows: [{ dead_lettered: true }],
      command: "UPDATE",
      rowCount: 1,
      oid: 0,
      fields: [],
    });
    const store = new SqlOutboxStore({ query } as unknown as Pick<Pool, "query">);

    const deadLettered = await store.recordFailure("evt-sql-1", "HTTP 500", 5);
    expect(deadLettered).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("SET attempts = attempts + 1");
    expect(sql).toContain("failed_at = CASE WHEN attempts + 1 >= $3");
    expect(params).toEqual(["evt-sql-1", "HTTP 500", 5]);
  });
});
