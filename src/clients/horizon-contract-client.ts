import { IContractClient } from "./contract-client.interface.js";
import { ContractInteractionArgs, ContractCallResult, TransactionResult } from "./types.js";
import { ContractService } from "../services/contract.service.js";
import { ContractInvalidRequestError } from "../errors/contractErrors.js";
import { withTimeout } from "../utils/outbound-helper.js";
import { timeoutConfig } from "../config/timeouts.js";
import { validateFeeBumpTransaction } from "./fee-bump-validator.js";
import { CursorStore, InMemoryCursorStore } from "./cursor-store.js";

// ─── SSE reconnection constants ──────────────────────────────────────────────

/** Initial backoff delay (ms) before the first reconnect attempt. */
export const SSE_BACKOFF_BASE_MS = 1_000;

/** Maximum backoff delay (ms) — caps exponential growth. */
export const SSE_BACKOFF_MAX_MS = 30_000;

/** Multiplier applied to the backoff on each successive failure. */
export const SSE_BACKOFF_FACTOR = 2;

/**
 * Upper bound of the jitter window as a fraction of the current backoff value.
 * e.g. 0.3 → up to ±30 % of the base delay is added randomly.
 */
export const SSE_JITTER_FACTOR = 0.3;

// ─── SSE public types ─────────────────────────────────────────────────────────

/** A single SSE event parsed from the Horizon stream. */
export interface HorizonSseEvent {
  /** Horizon paging token — use as the next `resumeAfter` cursor. */
  cursor: string;
  /** Raw event type field from the SSE frame (e.g. "payment", "close"). */
  eventType: string;
  /** Parsed JSON data payload from the `data:` field. */
  data: unknown;
}

/** Options accepted by {@link HorizonContractClient.streamEvents}. */
export interface StreamEventsOptions {
  /**
   * Horizon resource path to stream, relative to the base URL.
   * e.g. `/accounts/GABC…/payments`
   */
  path: string;

  /**
   * Key used to read / write the cursor in the {@link CursorStore}.
   * Defaults to the `path` if omitted.
   */
  streamKey?: string;

  /**
   * Override the initial cursor.  When supplied, this value is used for the
   * very first connection instead of whatever is in the cursor store.
   */
  resumeAfter?: string;

  /**
   * Invoked for every successfully parsed event.
   * **Must** be async-safe — the stream waits for the promise to resolve
   * before advancing to the next event so that the cursor is only saved
   * after the caller has handled the event.
   */
  onEvent: (event: HorizonSseEvent) => Promise<void>;

  /**
   * Invoked whenever a reconnect attempt is about to be made.
   * Useful for metrics / logging.
   */
  onReconnect?: (attempt: number, delayMs: number, cursor: string | undefined) => void;

  /**
   * AbortSignal — when aborted, the stream stops cleanly without throwing.
   */
  signal?: AbortSignal;

  /**
   * Cursor store to use for durable bookmark persistence.
   * Defaults to a new {@link InMemoryCursorStore} per stream if omitted.
   */
  cursorStore?: CursorStore;

  /**
   * Override for the initial backoff in tests.  Defaults to
   * {@link SSE_BACKOFF_BASE_MS}.
   */
  backoffBaseMs?: number;

  /**
   * Override for the maximum backoff in tests.  Defaults to
   * {@link SSE_BACKOFF_MAX_MS}.
   */
  backoffMaxMs?: number;
}

/**
 * Stellar Horizon HTTP API client implementing IContractClient.
 *
 * Maps Horizon REST endpoints onto the generic contract interface:
 *   - call()            → GET  /accounts/:address  (read-only queries)
 *   - sendTransaction() → POST /transactions        (XDR envelope submission)
 *   - streamEvents()    → SSE  /<path>?cursor=<cursor>  (streaming with reconnect)
 *
 * The `method` field in ContractInteractionArgs selects the Horizon operation:
 *   call:            "getAccount" | "getTransactions" | "getTransaction"
 *   sendTransaction: "submitTransaction"
 *
 * `args[0]` carries the primary resource identifier (account id, tx hash, or XDR).
 */
export class HorizonContractClient implements IContractClient {
  private readonly horizonUrl: string;
  private readonly networkPassphrase: string;
  private readonly contractService: ContractService;

  constructor(horizonUrl: string, networkPassphrase: string, contractService: ContractService) {
    this.horizonUrl = horizonUrl.replace(/\/$/, "");
    this.networkPassphrase = networkPassphrase;
    this.contractService = contractService;
  }

  /**
   * Executes a read-only Horizon query.
   *
   * Supported methods:
   *   - "getAccount"      → GET /accounts/{args[0]}
   *   - "getTransactions" → GET /accounts/{args[0]}/transactions
   *   - "getTransaction"  → GET /transactions/{args[0]}
   */
  async call<T>(args: ContractInteractionArgs): Promise<ContractCallResult<T>> {
    const url = this.buildReadUrl(args.method, args.args);

    const data = await this.contractService.call<T>(
      `horizon:${args.method}`,
      () =>
        withTimeout(
          async (signal) => this.fetchJson<T>(url, { signal }),
          timeoutConfig.http.contractMs,
          "horizon",
        ),
    );

    return { data, blockNumber: 0 };
  }

  /**
   * Submits a signed Stellar transaction XDR envelope to Horizon.
   *
   * args.args[0] must be the base64-encoded XDR transaction envelope.
   */
  async sendTransaction(args: ContractInteractionArgs): Promise<TransactionResult> {
    const xdr = args.args[0] as string;

    if (this.isFeeBumpTransaction(xdr)) {
      validateFeeBumpTransaction(xdr);
    }

    const url = `${this.horizonUrl}/transactions`;

    const response = await this.contractService.sendTransaction<{ hash: string }>(
      "horizon:submitTransaction",
      () =>
        withTimeout(
          async (signal) =>
            this.fetchJson<{ hash: string }>(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: `tx=${encodeURIComponent(xdr)}`,
              signal,
            }),
          timeoutConfig.http.contractMs,
          "horizon",
        ),
    );

    return {
      hash: response.hash,
      wait: async () => {
        const txUrl = `${this.horizonUrl}/transactions/${response.hash}`;
        return withTimeout(
          async (signal) => this.fetchJson(txUrl, { signal }),
          timeoutConfig.http.contractMs,
          "horizon",
        );
      },
    };
  }

  /**
   * Opens an SSE stream to a Horizon resource and calls `onEvent` for every
   * received event.
   *
   * Key behaviours
   * ──────────────
   * • **Cursor resumption** — On each (re)connect the last known cursor is
   *   appended as `?cursor=<value>` (or `?cursor=now` for a fresh stream).
   *   After `onEvent` resolves successfully the cursor is persisted so that
   *   the next reconnect resumes exactly from the following event.
   *
   * • **Jittered exponential backoff** — Connection failures are retried with
   *   a delay that starts at `backoffBaseMs` (default 1 s), doubles on each
   *   failure up to `backoffMaxMs` (default 30 s), and has a random jitter of
   *   ±{@link SSE_JITTER_FACTOR} × base applied to avoid thundering-herd.
   *
   * • **Graceful cancellation** — Passing an `AbortSignal` lets the caller
   *   stop the stream without the method throwing.
   *
   * • **Edge-case cursors**
   *   - `"now"` — subscribe to only new events (no historical replay).
   *   - A very stale cursor that Horizon no longer recognises causes a 400
   *     error; the stream is terminated (not retried) and the error is
   *     rethrown so the caller can clear the cursor and restart fresh.
   *   - Any 4xx response (401, 404, etc.) is treated as a non-retryable
   *     client error and propagated immediately.
   *   - A cursor equal to or beyond the latest ledger sequence behaves like
   *     `"now"` — Horizon streams future events as they arrive.
   *
   * @param options  See {@link StreamEventsOptions}.
   */
  async streamEvents(options: StreamEventsOptions): Promise<void> {
    const {
      path,
      streamKey = path,
      onEvent,
      onReconnect,
      signal,
      backoffBaseMs = SSE_BACKOFF_BASE_MS,
      backoffMaxMs = SSE_BACKOFF_MAX_MS,
    } = options;

    const cursorStore: CursorStore = options.cursorStore ?? new InMemoryCursorStore();

    // Seed the store with the caller-supplied resumeAfter cursor if provided.
    if (options.resumeAfter !== undefined) {
      await cursorStore.set(streamKey, options.resumeAfter);
    }

    let backoff = backoffBaseMs;
    let attempt = 0;

    while (true) {
      // Honour cancellation before each connection attempt.
      if (signal?.aborted) return;

      const cursor = await cursorStore.get(streamKey);

      if (attempt > 0) {
        const jitter = Math.floor(Math.random() * backoff * SSE_JITTER_FACTOR);
        const delay = backoff + jitter;
        onReconnect?.(attempt, delay, cursor);
        await this.sleep(delay, signal);
        if (signal?.aborted) return;
      }

      attempt++;

      try {
        await this.connectAndStream({ path, streamKey, cursor, onEvent, signal, cursorStore });
        // connectAndStream returned normally (signal aborted or server closed).
        return;
      } catch (err: any) {
        // Any 4xx from Horizon is a client error — not retryable.
        // 400 = stale/invalid cursor; 401 = auth; 404 = unknown resource; etc.
        // Propagate so the caller can react (e.g. clear cursor, re-auth).
        if (err instanceof HorizonHttpError && err.statusCode >= 400 && err.statusCode < 500) {
          throw err;
        }

        // 5xx / network errors: back off and retry.
        backoff = Math.min(backoff * SSE_BACKOFF_FACTOR, backoffMaxMs);

        // If aborted during a connection attempt, exit cleanly.
        if (signal?.aborted) return;
      }
    }
  }

  /**
   * Opens a single SSE connection and processes events until the connection
   * closes, an error is thrown, or the AbortSignal fires.
   *
   * @internal
   */
  private async connectAndStream(params: {
    path: string;
    streamKey: string;
    cursor: string | undefined;
    onEvent: StreamEventsOptions["onEvent"];
    signal: AbortSignal | undefined;
    cursorStore: CursorStore;
  }): Promise<void> {
    const { path, streamKey, cursor, onEvent, signal, cursorStore } = params;

    const cursorParam = cursor ?? "now";
    const url = `${this.horizonUrl}${path}?cursor=${encodeURIComponent(cursorParam)}`;

    const response = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new HorizonHttpError(response.status, body);
    }

    if (!response.body) {
      // Should not happen with a real SSE endpoint, but guard for tests.
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (signal?.aborted) return;

        const { done, value } = await reader.read();
        if (done) return;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by double newlines.
        const frames = buffer.split(/\r?\n\r?\n/);
        // The last element is either empty or a partial frame — keep it.
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          if (!frame.trim()) continue;

          const parsed = this.parseSseFrame(frame);
          if (!parsed) continue;

          // Deliver the event to the caller and only then persist the cursor.
          await onEvent(parsed);
          await cursorStore.set(streamKey, parsed.cursor);
        }
      }
    } finally {
      reader.cancel().catch(() => {
        // Ignore cancel errors during cleanup.
      });
    }
  }

  /**
   * Parses a single SSE frame (multi-line block between double newlines).
   *
   * Horizon SSE frames look like:
   * ```
   * event: payment
   * data: {"id":"cursor-value","..."}
   * ```
   *
   * The `id` field inside the JSON `data` object is used as the cursor.
   *
   * @returns Parsed event, or `null` if the frame is not a data-bearing event.
   * @internal
   */
  private parseSseFrame(frame: string): HorizonSseEvent | null {
    let eventType = "message";
    let dataLine = "";

    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        eventType = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLine = line.slice("data:".length).trim();
      }
    }

    if (!dataLine) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(dataLine);
    } catch {
      return null;
    }

    // Horizon returns the paging token as `id` in the data JSON.
    const cursor: string =
      typeof parsed?.paging_token === "string"
        ? parsed.paging_token
        : typeof parsed?.id === "string"
          ? parsed.id
          : "";

    return { cursor, eventType, data: parsed };
  }

  /**
   * Resolves after `ms` milliseconds, or immediately if the signal fires first.
   * @internal
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const id = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(id);
        resolve();
      });
    });
  }

  private isFeeBumpTransaction(xdrBase64: string): boolean {
    try {
      const buf = Buffer.from(xdrBase64, "base64");
      if (buf.length < 4) return false;
      return buf.readInt32BE(0) === 4;
    } catch {
      return false;
    }
  }

  private buildReadUrl(method: string, methodArgs: any[]): string {
    const id = methodArgs[0] as string;
    switch (method) {
      case "getAccount":
        return `${this.horizonUrl}/accounts/${encodeURIComponent(id)}`;
      case "getTransactions":
        return `${this.horizonUrl}/accounts/${encodeURIComponent(id)}/transactions`;
      case "getTransaction":
        return `${this.horizonUrl}/transactions/${encodeURIComponent(id)}`;
      case "getLatestLedger":
        return `${this.horizonUrl}/ledgers?limit=1&order=desc`;
      default:
        throw new ContractInvalidRequestError(`Unknown Horizon method: ${method}`);
    }
  }

  private async fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      // Network-level error (ECONNRESET, ETIMEDOUT, etc.) — rethrow raw so
      // mapContractError in ContractService can classify it correctly.
      throw err;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new HorizonHttpError(response.status, body);
    }

    try {
      return (await response.json()) as T;
    } catch {
      // "malformed" doesn't match any mapContractError pattern → ContractExecutionError
      throw new Error("Horizon returned malformed JSON response");
    }
  }
}

/**
 * Represents an HTTP error from the Horizon API.
 * The message is crafted to match patterns in mapContractError:
 *   - 5xx → "service unavailable" → ContractProviderUnavailableError
 *   - 429 → "rate limit"          → ContractRateLimitError
 *   - 4xx → "invalid argument"    → ContractInvalidRequestError
 */
export class HorizonHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    body: string,
  ) {
    super(HorizonHttpError.buildMessage(statusCode, body));
    this.name = "HorizonHttpError";
  }

  private static buildMessage(status: number, body: string): string {
    const detail = body.slice(0, 200);
    if (status >= 500) return `service unavailable: Horizon HTTP ${status}: ${detail}`;
    if (status === 429) return `rate limit exceeded: Horizon HTTP ${status}: ${detail}`;
    return `invalid argument: Horizon HTTP ${status}: ${detail}`;
  }
}
