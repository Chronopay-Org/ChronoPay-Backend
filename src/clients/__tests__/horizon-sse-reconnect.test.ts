// @ts-nocheck
/**
 * Comprehensive tests for HorizonContractClient.streamEvents()
 *
 * Covers:
 *  - Normal streaming (events delivered, cursors saved)
 *  - Mid-stream disconnects with cursor resume
 *  - Jittered exponential backoff timing assertions
 *  - AbortSignal cancellation (before connect, during stream, during backoff)
 *  - Edge-case cursors: "now", very stale (400), cursor at head, cursor beyond head
 *  - Network-level errors triggering reconnect
 *  - Server-side close (done: true) without error
 *  - InMemoryCursorStore isolation
 *  - parseSseFrame edge cases (missing data, malformed JSON, paging_token vs id)
 */

import { jest } from "@jest/globals";
import {
  HorizonContractClient,
  HorizonHttpError,
  HorizonSseEvent,
  SSE_BACKOFF_BASE_MS,
  SSE_BACKOFF_MAX_MS,
  SSE_BACKOFF_FACTOR,
  SSE_JITTER_FACTOR,
} from "../../clients/horizon-contract-client.js";
import { InMemoryCursorStore } from "../../clients/cursor-store.js";
import { ContractService } from "../../services/contract.service.js";
import { RetryPolicy } from "../../utils/retry-policy.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const _ACCOUNT_ID = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

// ─── Factories ────────────────────────────────────────────────────────────────

function makeService(): ContractService {
  return new ContractService(
    new RetryPolicy({
      maxRetries: 0,
      initialDelay: 0,
      backoffFactor: 1,
      maxDelay: 0,
      useJitter: false,
    }),
  );
}

function makeClient(url = BASE_URL): HorizonContractClient {
  return new HorizonContractClient(url, PASSPHRASE, makeService());
}

// ─── SSE frame builders ───────────────────────────────────────────────────────

/** Builds a minimal Horizon-style SSE frame. */
function sseFrame(
  pagingToken: string,
  extraFields: Record<string, unknown> = {},
  eventType = "payment",
): string {
  const data = JSON.stringify({ paging_token: pagingToken, ...extraFields });
  return `event: ${eventType}\ndata: ${data}`;
}

/** Converts an array of SSE frame strings into a ReadableStream<Uint8Array>. */
function framesToStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream({
    pull(controller) {
      if (idx >= frames.length) {
        controller.close();
        return;
      }
      // Frames separated by double newline as per SSE spec.
      controller.enqueue(encoder.encode(frames[idx++] + "\n\n"));
    },
  });
}

/** Creates a stream that errors after delivering the given frames. */
function framesToStreamThenError(frames: string[], error: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream({
    pull(controller) {
      if (idx < frames.length) {
        controller.enqueue(encoder.encode(frames[idx++] + "\n\n"));
        return;
      }
      controller.error(error);
    },
  });
}

// ─── fetch mock ───────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** Queues a successful SSE response. */
function mockSseOk(body: ReadableStream<Uint8Array>) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    body,
    text: async () => "",
  } as unknown as Response);
}

/** Queues an HTTP error response. */
function mockSseHttpError(status: number, body = "") {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    body: null,
    text: async () => body,
  } as unknown as Response);
}

/** Queues a network-level rejection. */
function mockNetworkError(message = "ECONNRESET") {
  mockFetch.mockRejectedValueOnce(new Error(message));
}

beforeEach(() => {
  mockFetch.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryCursorStore
// ─────────────────────────────────────────────────────────────────────────────

describe("InMemoryCursorStore", () => {
  it("returns undefined for an unknown key", async () => {
    const store = new InMemoryCursorStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a cursor", async () => {
    const store = new InMemoryCursorStore();
    await store.set("payments:GACC", "tok-42");
    expect(await store.get("payments:GACC")).toBe("tok-42");
  });

  it("overwrites the cursor on successive sets", async () => {
    const store = new InMemoryCursorStore();
    await store.set("k", "v1");
    await store.set("k", "v2");
    expect(await store.get("k")).toBe("v2");
  });

  it("deletes a cursor", async () => {
    const store = new InMemoryCursorStore();
    await store.set("k", "v");
    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
  });

  it("delete on a missing key is a no-op", async () => {
    const store = new InMemoryCursorStore();
    await expect(store.delete("absent")).resolves.toBeUndefined();
  });

  it("size reflects the number of stored cursors", async () => {
    const store = new InMemoryCursorStore();
    expect(store.size).toBe(0);
    await store.set("a", "1");
    await store.set("b", "2");
    expect(store.size).toBe(2);
  });

  it("clear removes all cursors", async () => {
    const store = new InMemoryCursorStore();
    await store.set("a", "1");
    await store.set("b", "2");
    store.clear();
    expect(store.size).toBe(0);
    expect(await store.get("a")).toBeUndefined();
  });

  it("independent stores do not share state", async () => {
    const s1 = new InMemoryCursorStore();
    const s2 = new InMemoryCursorStore();
    await s1.set("k", "s1-value");
    expect(await s2.get("k")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// streamEvents() — happy-path
// ─────────────────────────────────────────────────────────────────────────────

describe("HorizonContractClient.streamEvents() — happy path", () => {
  it("delivers events and saves cursors in order", async () => {
    const store = new InMemoryCursorStore();
    const client = makeClient();
    const received: HorizonSseEvent[] = [];

    mockSseOk(
      framesToStream([
        sseFrame("tok-1", { amount: "100" }),
        sseFrame("tok-2", { amount: "200" }),
        sseFrame("tok-3", { amount: "300" }),
      ]),
    );

    const ac = new AbortController();
    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      cursorStore: store,
      signal: ac.signal,
      onEvent: async (ev) => {
        received.push(ev);
      },
    });

    // Allow microtasks/stream reads to complete
    await jest.runAllTimersAsync();
    await streamPromise;

    expect(received).toHaveLength(3);
    expect(received[0].cursor).toBe("tok-1");
    expect(received[1].cursor).toBe("tok-2");
    expect(received[2].cursor).toBe("tok-3");

    // Final persisted cursor is the last one
    expect(await store.get("/accounts/GACC/payments")).toBe("tok-3");
  });

  it("uses 'now' as cursor when no prior cursor exists", async () => {
    const store = new InMemoryCursorStore();
    const client = makeClient();

    mockSseOk(framesToStream([]));

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      cursorStore: store,
      onEvent: async () => {},
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("cursor=now"),
      expect.any(Object),
    );
  });

  it("appends existing cursor from store on first connect", async () => {
    const store = new InMemoryCursorStore();
    await store.set("/accounts/GACC/payments", "tok-99");
    const client = makeClient();

    mockSseOk(framesToStream([]));

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      cursorStore: store,
      onEvent: async () => {},
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("cursor=tok-99"),
      expect.any(Object),
    );
  });

  it("uses resumeAfter to override the stored cursor on first connect", async () => {
    const store = new InMemoryCursorStore();
    await store.set("/accounts/GACC/payments", "old-cursor");
    const client = makeClient();

    mockSseOk(framesToStream([]));

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      cursorStore: store,
      resumeAfter: "override-cursor",
      onEvent: async () => {},
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("cursor=override-cursor"),
      expect.any(Object),
    );
  });

  it("sets Accept: text/event-stream header", async () => {
    mockSseOk(framesToStream([]));
    const client = makeClient();

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      onEvent: async () => {},
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "text/event-stream" }),
      }),
    );
  });

  it("uses custom streamKey independent of path", async () => {
    const store = new InMemoryCursorStore();
    await store.set("custom-key", "custom-tok");
    const client = makeClient();

    mockSseOk(framesToStream([sseFrame("new-tok")]));

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      streamKey: "custom-key",
      cursorStore: store,
      onEvent: async () => {},
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("cursor=custom-tok"),
      expect.any(Object),
    );
    // Cursor is saved under the custom key
    expect(await store.get("custom-key")).toBe("new-tok");
    // Path key is untouched
    expect(await store.get("/accounts/GACC/payments")).toBeUndefined();
  });

  it("falls back to id field when paging_token is absent", async () => {
    const store = new InMemoryCursorStore();
    const client = makeClient();
    const received: HorizonSseEvent[] = [];

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: tx\ndata: {"id":"id-cursor-1","foo":"bar"}\n\n'),
        );
        controller.close();
      },
    });

    mockSseOk(body);

    await client.streamEvents({
      path: "/accounts/GACC/transactions",
      cursorStore: store,
      onEvent: async (ev) => received.push(ev),
    });

    expect(received[0].cursor).toBe("id-cursor-1");
    expect(await store.get("/accounts/GACC/transactions")).toBe("id-cursor-1");
  });

  it("strips trailing slash from base URL in SSE request", async () => {
    mockSseOk(framesToStream([]));
    const client = makeClient(`${BASE_URL}/`);

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      onEvent: async () => {},
    });

    const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
    expect(calledUrl).not.toContain("//accounts");
  });

  it("returns without error when response.body is null", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: null,
      text: async () => "",
    } as unknown as Response);

    const client = makeClient();
    await expect(
      client.streamEvents({
        path: "/accounts/GACC/payments",
        onEvent: async () => {},
      }),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// streamEvents() — cursor resume after disconnect
// ─────────────────────────────────────────────────────────────────────────────

describe("HorizonContractClient.streamEvents() — cursor resume after disconnect", () => {
  it("resumes from last-acked cursor after a network error", async () => {
    const store = new InMemoryCursorStore();
    const client = makeClient();
    const received: HorizonSseEvent[] = [];

    // First connection: delivers tok-1, then errors mid-stream
    mockSseOk(framesToStreamThenError([sseFrame("tok-1")], new Error("ECONNRESET")));

    // Second connection (reconnect): delivers tok-2 then closes
    mockSseOk(framesToStream([sseFrame("tok-2")]));

    const ac = new AbortController();
    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      cursorStore: store,
      signal: ac.signal,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      onEvent: async (ev) => received.push(ev),
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    expect(received).toHaveLength(2);
    expect(received[0].cursor).toBe("tok-1");
    expect(received[1].cursor).toBe("tok-2");

    // Second fetch must use tok-1 as the resume cursor
    const secondCallUrl = (mockFetch.mock.calls[1] as [string])[0];
    expect(secondCallUrl).toContain("cursor=tok-1");
  });

  it("resumes from last-acked cursor after a 5xx error mid-stream", async () => {
    const store = new InMemoryCursorStore();
    const client = makeClient();
    const received: HorizonSseEvent[] = [];

    // First connection: delivers tok-A then errors with a network failure
    // (simulating what happens when the server drops the SSE stream after a 503)
    mockSseOk(framesToStreamThenError([sseFrame("tok-A")], new Error("ECONNRESET after 503")));
    // Second connection (reconnect): 503 at connect time
    mockSseHttpError(503, "Service Unavailable");
    // Third connection: delivers tok-B then closes cleanly
    mockSseOk(framesToStream([sseFrame("tok-B")]));

    const ac = new AbortController();
    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      cursorStore: store,
      signal: ac.signal,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      onEvent: async (ev) => received.push(ev),
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    expect(received.map((e) => e.cursor)).toEqual(["tok-A", "tok-B"]);

    // Second and third fetches both carry tok-A as the cursor
    const secondCallUrl = (mockFetch.mock.calls[1] as [string])[0];
    const thirdCallUrl = (mockFetch.mock.calls[2] as [string])[0];
    expect(secondCallUrl).toContain("cursor=tok-A");
    expect(thirdCallUrl).toContain("cursor=tok-A");
  });

  it("does not skip events between disconnects when cursor persisted correctly", async () => {
    const store = new InMemoryCursorStore();
    const client = makeClient();
    const received: string[] = [];

    // Simulate three separate connections, each delivering a single event
    for (const tok of ["tok-10", "tok-20", "tok-30"]) {
      mockSseOk(framesToStreamThenError([sseFrame(tok)], new Error("drop")));
    }
    // Final clean close
    mockSseOk(framesToStream([]));

    const ac = new AbortController();
    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      cursorStore: store,
      signal: ac.signal,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      onEvent: async (ev) => received.push(ev.cursor),
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    expect(received).toEqual(["tok-10", "tok-20", "tok-30"]);
    // Each reconnect used the previously acked cursor
    const urls = mockFetch.mock.calls.map((c) => (c as [string])[0]);
    expect(urls[1]).toContain("cursor=tok-10");
    expect(urls[2]).toContain("cursor=tok-20");
    expect(urls[3]).toContain("cursor=tok-30");
  });

  it("cursor is not advanced when onEvent throws", async () => {
    const store = new InMemoryCursorStore();
    await store.set("/p", "tok-0");
    const client = makeClient();

    // Deliver tok-1; onEvent will throw for tok-1 so cursor must stay at tok-0
    mockSseOk(framesToStream([sseFrame("tok-1")]));
    // Second connection after backoff — just close cleanly
    mockSseOk(framesToStream([]));

    const ac = new AbortController();
    const streamPromise = client.streamEvents({
      path: "/p",
      cursorStore: store,
      signal: ac.signal,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      onEvent: async () => {
        throw new Error("handler error");
      },
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    // cursor must NOT have been advanced past tok-0
    expect(await store.get("/p")).toBe("tok-0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// streamEvents() — jittered exponential backoff
// ─────────────────────────────────────────────────────────────────────────────

describe("HorizonContractClient.streamEvents() — jittered exponential backoff", () => {
  it("calls onReconnect with increasing delay and attempt number", async () => {
    const client = makeClient();
    const reconnects: Array<{ attempt: number; delayMs: number }> = [];

    const BASE = 100;
    const MAX = 800;

    // Three failures then a clean close
    mockNetworkError("fail-1");
    mockNetworkError("fail-2");
    mockNetworkError("fail-3");
    mockSseOk(framesToStream([]));

    const ac = new AbortController();
    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      backoffBaseMs: BASE,
      backoffMaxMs: MAX,
      signal: ac.signal,
      onReconnect: (attempt, delayMs) => reconnects.push({ attempt, delayMs }),
      onEvent: async () => {},
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    expect(reconnects).toHaveLength(3);

    // Attempt numbers must be 1, 2, 3 (1-based)
    expect(reconnects[0].attempt).toBe(1);
    expect(reconnects[1].attempt).toBe(2);
    expect(reconnects[2].attempt).toBe(3);

    // Delays must be non-negative and capped at MAX
    for (const { delayMs } of reconnects) {
      expect(delayMs).toBeGreaterThanOrEqual(0);
      expect(delayMs).toBeLessThanOrEqual(MAX * (1 + SSE_JITTER_FACTOR));
    }

    // Each delay must be >= the previous base (before jitter), i.e. delay[n] >= delay[n-1] / (1+jitter)
    // We relax this to just check monotonic non-decrease of the base (without jitter noise).
    // The most reliable assertion: delay[1] base is BASE*FACTOR, delay[2] base is BASE*FACTOR^2.
    expect(reconnects[1].delayMs).toBeGreaterThanOrEqual(reconnects[0].delayMs * SSE_BACKOFF_FACTOR * (1 - SSE_JITTER_FACTOR) - 1);
  });

  it("caps backoff at backoffMaxMs", async () => {
    const client = makeClient();
    const delays: number[] = [];

    const BASE = 100;
    const MAX = 200; // Very low cap — should be hit by attempt 2

    // Five failures then clean close
    for (let i = 0; i < 5; i++) mockNetworkError();
    mockSseOk(framesToStream([]));

    const ac = new AbortController();
    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      backoffBaseMs: BASE,
      backoffMaxMs: MAX,
      signal: ac.signal,
      onReconnect: (_, d) => delays.push(d),
      onEvent: async () => {},
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    // All delays (including jitter) must not exceed MAX * (1 + jitter_factor) + 1ms rounding
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(MAX * (1 + SSE_JITTER_FACTOR) + 1);
    }
  });

  it("delay is always non-negative even with jitter", async () => {
    const client = makeClient();
    const delays: number[] = [];

    for (let i = 0; i < 10; i++) mockNetworkError();
    mockSseOk(framesToStream([]));

    const ac = new AbortController();
    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      backoffBaseMs: 1,
      backoffMaxMs: 10,
      signal: ac.signal,
      onReconnect: (_, d) => delays.push(d),
      onEvent: async () => {},
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  it("SSE_BACKOFF constants have expected default values", () => {
    expect(SSE_BACKOFF_BASE_MS).toBe(1_000);
    expect(SSE_BACKOFF_MAX_MS).toBe(30_000);
    expect(SSE_BACKOFF_FACTOR).toBe(2);
    expect(SSE_JITTER_FACTOR).toBe(0.3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// streamEvents() — AbortSignal cancellation
// ─────────────────────────────────────────────────────────────────────────────

describe("HorizonContractClient.streamEvents() — AbortSignal cancellation", () => {
  it("returns without error when aborted before first connect", async () => {
    const client = makeClient();
    const ac = new AbortController();
    ac.abort(); // pre-aborted

    await expect(
      client.streamEvents({
        path: "/accounts/GACC/payments",
        signal: ac.signal,
        onEvent: async () => {},
      }),
    ).resolves.toBeUndefined();

    // No fetch should have been made
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stops the stream cleanly when signal fires mid-stream", async () => {
    const client = makeClient();
    const ac = new AbortController();
    const received: string[] = [];

    const encoder = new TextEncoder();
    // A stream that never closes on its own — we abort it externally
    let _streamController: ReadableStreamDefaultController<Uint8Array>;
    const neverEndingStream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        _streamController = ctrl;
        ctrl.enqueue(encoder.encode(sseFrame("tok-A") + "\n\n"));
      },
    });

    mockSseOk(neverEndingStream);

    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      signal: ac.signal,
      onEvent: async (ev) => {
        received.push(ev.cursor);
        // Abort after receiving the first event
        ac.abort();
      },
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    expect(received).toHaveLength(1);
    expect(received[0]).toBe("tok-A");
  });

  it("stops during backoff sleep when signal fires", async () => {
    const client = makeClient();
    const ac = new AbortController();

    // One failure to trigger backoff
    mockNetworkError("drop");
    // If it connects again, return empty stream
    mockSseOk(framesToStream([]));

    const reconnects: number[] = [];
    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      backoffBaseMs: 5000,
      backoffMaxMs: 10000,
      signal: ac.signal,
      onReconnect: (attempt) => {
        reconnects.push(attempt);
        // Abort during the backoff window
        ac.abort();
      },
      onEvent: async () => {},
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    // The stream should have exited cleanly without making a second fetch
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(reconnects).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// streamEvents() — edge-case cursors
// ─────────────────────────────────────────────────────────────────────────────

describe("HorizonContractClient.streamEvents() — edge-case cursors", () => {
  it('"now" cursor: subscribes to new events only, no historical replay', async () => {
    const store = new InMemoryCursorStore();
    const client = makeClient();

    mockSseOk(framesToStream([]));

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      resumeAfter: "now",
      cursorStore: store,
      onEvent: async () => {},
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("cursor=now"),
      expect.any(Object),
    );
  });

  it("very stale cursor (400) is not retried — error propagated to caller", async () => {
    const store = new InMemoryCursorStore();
    await store.set("/accounts/GACC/payments", "stale-tok-from-2019");
    const client = makeClient();

    mockSseHttpError(400, "cursor is invalid (too old)");

    await expect(
      client.streamEvents({
        path: "/accounts/GACC/payments",
        cursorStore: store,
        onEvent: async () => {},
      }),
    ).rejects.toBeInstanceOf(HorizonHttpError);

    // Only one fetch attempt — 400 must NOT be retried
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("very stale cursor (400) error has correct statusCode", async () => {
    const client = makeClient();
    mockSseHttpError(400, "cursor expired");

    let caughtError: unknown;
    try {
      await client.streamEvents({
        path: "/accounts/GACC/payments",
        onEvent: async () => {},
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(HorizonHttpError);
    expect((caughtError as HorizonHttpError).statusCode).toBe(400);
  });

  it("cursor at head (latest paging token): stream opens and waits for new events", async () => {
    const store = new InMemoryCursorStore();
    const client = makeClient();
    const received: string[] = [];

    // Cursor at head — the connection opens successfully, no historic events
    // but new ones arrive, then stream closes
    mockSseOk(framesToStream([sseFrame("tok-head+1")]));

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      resumeAfter: "tok-head",
      cursorStore: store,
      onEvent: async (ev) => received.push(ev.cursor),
    });

    expect(received).toEqual(["tok-head+1"]);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("cursor=tok-head"),
      expect.any(Object),
    );
  });

  it("cursor beyond head behaves like 'now' — Horizon streams future events", async () => {
    const store = new InMemoryCursorStore();
    const client = makeClient();
    const received: string[] = [];

    // Horizon accepts the cursor and streams events as they arrive
    mockSseOk(framesToStream([sseFrame("future-tok-1")]));

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      resumeAfter: "9999999999999999999",
      cursorStore: store,
      onEvent: async (ev) => received.push(ev.cursor),
    });

    expect(received).toEqual(["future-tok-1"]);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("cursor=9999999999999999999"),
      expect.any(Object),
    );
  });

  it("URL-encodes cursor values with special characters", async () => {
    const client = makeClient();
    mockSseOk(framesToStream([]));

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      resumeAfter: "cursor+with spaces/and=signs",
      onEvent: async () => {},
    });

    const url = (mockFetch.mock.calls[0] as [string])[0];
    expect(url).not.toContain(" ");
    expect(url).toContain("cursor=");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// streamEvents() — error propagation and retry behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("HorizonContractClient.streamEvents() — error propagation", () => {
  it("retries on network error and eventually succeeds", async () => {
    const client = makeClient();

    mockNetworkError("ETIMEDOUT");
    mockNetworkError("ECONNRESET");
    mockSseOk(framesToStream([sseFrame("tok-final")]));

    const received: string[] = [];
    const ac = new AbortController();
    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      signal: ac.signal,
      onEvent: async (ev) => received.push(ev.cursor),
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(received).toEqual(["tok-final"]);
  });

  it("retries on 5xx and eventually succeeds", async () => {
    const client = makeClient();

    mockSseHttpError(503, "temporarily unavailable");
    mockSseHttpError(502, "bad gateway");
    mockSseOk(framesToStream([sseFrame("tok-ok")]));

    const received: string[] = [];
    const ac = new AbortController();
    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      signal: ac.signal,
      onEvent: async (ev) => received.push(ev.cursor),
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(received).toEqual(["tok-ok"]);
  });

  it("does NOT retry on 400 bad-cursor error", async () => {
    const client = makeClient();

    mockSseHttpError(400, "cursor invalid");

    await expect(
      client.streamEvents({
        path: "/accounts/GACC/payments",
        onEvent: async () => {},
      }),
    ).rejects.toBeInstanceOf(HorizonHttpError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 401 unauthorised", async () => {
    const client = makeClient();
    mockSseHttpError(401, "unauthorized");

    await expect(
      client.streamEvents({
        path: "/accounts/GACC/payments",
        onEvent: async () => {},
      }),
    ).rejects.toBeInstanceOf(HorizonHttpError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 404 not found", async () => {
    const client = makeClient();
    mockSseHttpError(404, "not found");

    await expect(
      client.streamEvents({
        path: "/accounts/GACC/payments",
        onEvent: async () => {},
      }),
    ).rejects.toBeInstanceOf(HorizonHttpError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("passes the current cursor to onReconnect callback", async () => {
    const store = new InMemoryCursorStore();
    await store.set("/p", "tok-saved");
    const client = makeClient();
    const cursorsSeen: Array<string | undefined> = [];

    mockNetworkError();
    mockSseOk(framesToStream([]));

    const ac = new AbortController();
    const streamPromise = client.streamEvents({
      path: "/p",
      cursorStore: store,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      signal: ac.signal,
      onReconnect: (_, __, cursor) => cursorsSeen.push(cursor),
      onEvent: async () => {},
    });

    await jest.runAllTimersAsync();
    await streamPromise;

    expect(cursorsSeen[0]).toBe("tok-saved");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseSseFrame — edge cases (tested indirectly via streamEvents)
// ─────────────────────────────────────────────────────────────────────────────

describe("SSE frame parsing edge cases", () => {
  it("ignores frames with no data line", async () => {
    const encoder = new TextEncoder();
    const client = makeClient();
    const received: HorizonSseEvent[] = [];

    // A frame with only an event line and no data:
    const noDataBody = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode("event: heartbeat\n\n"));
        ctrl.enqueue(encoder.encode(sseFrame("tok-real") + "\n\n"));
        ctrl.close();
      },
    });

    mockSseOk(noDataBody);

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      onEvent: async (ev) => received.push(ev),
    });

    expect(received).toHaveLength(1);
    expect(received[0].cursor).toBe("tok-real");
  });

  it("ignores frames with malformed JSON in data line", async () => {
    const encoder = new TextEncoder();
    const client = makeClient();
    const received: HorizonSseEvent[] = [];

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode("event: payment\ndata: {not valid json}\n\n"));
        ctrl.enqueue(encoder.encode(sseFrame("tok-valid") + "\n\n"));
        ctrl.close();
      },
    });

    mockSseOk(body);

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      onEvent: async (ev) => received.push(ev),
    });

    // Only the valid frame should be delivered
    expect(received).toHaveLength(1);
    expect(received[0].cursor).toBe("tok-valid");
  });

  it("sets empty string cursor when neither paging_token nor id present in data", async () => {
    const encoder = new TextEncoder();
    const client = makeClient();
    const received: HorizonSseEvent[] = [];

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode('event: payment\ndata: {"amount":"100"}\n\n'));
        ctrl.close();
      },
    });

    mockSseOk(body);

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      onEvent: async (ev) => received.push(ev),
    });

    expect(received).toHaveLength(1);
    expect(received[0].cursor).toBe("");
  });

  it("preserves event type from SSE frame", async () => {
    const encoder = new TextEncoder();
    const client = makeClient();
    const received: HorizonSseEvent[] = [];

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          encoder.encode('event: trade\ndata: {"paging_token":"tok-trade","price":"1.5"}\n\n'),
        );
        ctrl.close();
      },
    });

    mockSseOk(body);

    await client.streamEvents({
      path: "/accounts/GACC/trades",
      onEvent: async (ev) => received.push(ev),
    });

    expect(received[0].eventType).toBe("trade");
  });

  it("handles frames split across multiple chunks", async () => {
    const encoder = new TextEncoder();
    const client = makeClient();
    const received: HorizonSseEvent[] = [];

    // Split a single frame across three separate reads
    const frameStr = sseFrame("tok-chunked");
    const half1 = frameStr.slice(0, Math.floor(frameStr.length / 2));
    const half2 = frameStr.slice(Math.floor(frameStr.length / 2)) + "\n\n";

    let readCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (readCount === 0) {
          ctrl.enqueue(encoder.encode(half1));
        } else if (readCount === 1) {
          ctrl.enqueue(encoder.encode(half2));
        } else {
          ctrl.close();
        }
        readCount++;
      },
    });

    mockSseOk(body);

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      onEvent: async (ev) => received.push(ev),
    });

    expect(received).toHaveLength(1);
    expect(received[0].cursor).toBe("tok-chunked");
  });

  it("handles CRLF line endings in SSE frames", async () => {
    const encoder = new TextEncoder();
    const client = makeClient();
    const received: HorizonSseEvent[] = [];

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          encoder.encode(
            'event: payment\r\ndata: {"paging_token":"tok-crlf","amount":"50"}\r\n\r\n',
          ),
        );
        ctrl.close();
      },
    });

    mockSseOk(body);

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      onEvent: async (ev) => received.push(ev),
    });

    expect(received).toHaveLength(1);
    expect(received[0].cursor).toBe("tok-crlf");
  });

  it("handles multiple events in a single chunk", async () => {
    const encoder = new TextEncoder();
    const client = makeClient();
    const received: string[] = [];

    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        // Two full frames in a single enqueue
        ctrl.enqueue(
          encoder.encode(sseFrame("tok-multi-1") + "\n\n" + sseFrame("tok-multi-2") + "\n\n"),
        );
        ctrl.close();
      },
    });

    mockSseOk(body);

    await client.streamEvents({
      path: "/accounts/GACC/payments",
      onEvent: async (ev) => received.push(ev.cursor),
    });

    expect(received).toEqual(["tok-multi-1", "tok-multi-2"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sleep() abort-listener branch (lines 405-406 in horizon-contract-client.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe("HorizonContractClient.streamEvents() — abort during live sleep timer", () => {
  // This suite uses REAL timers so we can exercise the abort-event listener
  // inside sleep() (the clearTimeout + resolve() branch at lines 405-406).
  beforeEach(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useFakeTimers();
  });

  it("resolves cleanly when AbortController fires while sleep timer is active", async () => {
    const client = makeClient();
    const ac = new AbortController();

    // One network error → triggers a real backoff sleep of 100 ms
    mockNetworkError("drop");
    // Provide a fallback response in case reconnect fires before abort
    mockSseOk(framesToStream([]));

    const streamPromise = client.streamEvents({
      path: "/accounts/GACC/payments",
      backoffBaseMs: 100,
      backoffMaxMs: 200,
      signal: ac.signal,
      onReconnect: () => {
        // Fire abort 10 ms AFTER onReconnect returns so that the 100 ms
        // sleep timer is already running when the AbortSignal fires.
        // This exercises the addEventListener branch (lines 405-406).
        setTimeout(() => ac.abort(), 10);
      },
      onEvent: async () => {},
    });

    await expect(streamPromise).resolves.toBeUndefined();
    // Only one fetch — the reconnect was aborted during the sleep
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
