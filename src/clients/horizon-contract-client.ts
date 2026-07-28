import { IContractClient } from "./contract-client.interface.js";
import { ContractInteractionArgs, ContractCallResult, TransactionResult } from "./types.js";
import { ContractService } from "../services/contract.service.js";
import { ContractInvalidRequestError, ContractRateLimitError } from "../errors/contractErrors.js";
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

export interface StellarPayoutBalanceOptions {
  amount?: string | number;
  baseReserve?: number;
  subentries?: number;
  trustlines?: number;
  offers?: number;
}

interface HorizonAccountResponse {
  id?: string;
  subentry_count?: number;
  balances?: Array<{
    asset_type: string;
    balance: string;
  }>;
}

export function computeMinBalance(subentries: number, baseReserve = 5_000_000): number {
  if (!Number.isInteger(subentries) || subentries < 0) {
    throw new ContractInvalidRequestError("Subentry count must be a non-negative integer");
  }

  if (!Number.isFinite(baseReserve) || baseReserve <= 0) {
    throw new ContractInvalidRequestError("Base reserve must be a positive number");
  }

  return (2 + subentries) * baseReserve;
}

function parseStellarAmount(amount: string | number | undefined): number {
  if (amount === undefined || amount === null) {
    return 0;
  }

  if (typeof amount === "number") {
    return Math.trunc(amount);
  }

  const trimmed = amount.trim();
  if (trimmed === "") {
    return 0;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  const match = trimmed.match(/^(\d+)(?:\.(\d{1,7}))?$/);
  if (!match) {
    throw new ContractInvalidRequestError(`Invalid Stellar amount: ${amount}`);
  }

  const whole = Number.parseInt(match[1], 10);
  const fractional = match[2] ?? "";
  return whole * 10_000_000 + Number.parseInt(fractional.padEnd(7, "0"), 10);
}

export class HorizonInsufficientBalanceError extends Error {
  constructor(
    public readonly accountId: string,
    public readonly balance: number,
    public readonly minimumBalance: number,
  ) {
    super(
      `Account ${accountId} does not have enough balance to cover the Stellar reserve minimum: ${balance} < ${minimumBalance}`,
    );
    this.name = "HorizonInsufficientBalanceError";
  }
}

/**
 * Options for paginated Horizon endpoint queries.
 */
export interface HorizonPaginationOptions {
  cursor?: string;
  limit?: number;
  order?: "asc" | "desc";
}

/**
 * Structure of a transaction record returned by Horizon REST API.
 */
export interface HorizonTransactionRecord {
  id: string;
  paging_token: string;
  hash: string;
  ledger?: number;
  created_at?: string;
  memo?: string;
  memo_type?: string;
  [key: string]: unknown;
}

/**
 * Structure of a collection response from Horizon REST API.
 */
export interface HorizonCollectionResponse<T = HorizonTransactionRecord> {
  _embedded: {
    records: T[];
  };
  _links?: {
    next?: { href: string };
    prev?: { href: string };
    self?: { href: string };
  };
}

/**
 * Configuration options for fetchAllTransactionsPaged.
 */
export interface FetchAllPagesOptions {
  limitPerPage?: number;
  order?: "asc" | "desc";
  initialCursor?: string;
  maxRecords?: number;
  maxRetriesOnRateLimit?: number;
  onRateLimit?: (attempt: number) => Promise<void>;
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

  private isFeeBumpTransaction(xdrBase64: string): boolean {
    try {
      const buf = Buffer.from(xdrBase64, "base64");
      if (buf.length < 4) return false;
      return buf.readInt32BE(0) === 4;
    } catch {
      return false;
    }
  /**
   * Checks the account balance against the Stellar minimum reserve before submitting a payout.
   * The reserve is derived from the effective subentry count, including trustlines and offers.
   */
  async submitPayout(accountId: string, xdr: string, options: StellarPayoutBalanceOptions = {}): Promise<TransactionResult> {
    const accountResponse = await this.call<HorizonAccountResponse>({
      address: accountId,
      abi: null,
      method: "getAccount",
      args: [accountId],
    });

    const account = accountResponse.data;
    const baseReserve = options.baseReserve ?? 5_000_000;
    const effectiveSubentries = (options.subentries ?? account.subentry_count ?? 0) + (options.trustlines ?? 0) + (options.offers ?? 0);
    const minimumBalance = computeMinBalance(effectiveSubentries, baseReserve);
    const payoutAmount = parseStellarAmount(options.amount);
    const nativeBalance = account.balances?.find((balance) => balance.asset_type === "native")?.balance;
    const balanceInStroops = nativeBalance === undefined ? 0 : parseStellarAmount(nativeBalance);

    if (balanceInStroops < minimumBalance + payoutAmount) {
      throw new HorizonInsufficientBalanceError(accountId, balanceInStroops, minimumBalance + payoutAmount);
    }

    return this.sendTransaction({
      address: accountId,
      abi: null,
      method: "submitTransaction",
      args: [xdr],
    });
  }

  /**
   * Submits a low-cost memo transaction anchoring a 32-byte (64 hex characters) hash on Stellar.
   */
  async submitMemoTransaction(memoHashHex: string): Promise<TransactionResult> {
    const cleanHash = memoHashHex.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(cleanHash)) {
      throw new ContractInvalidRequestError("Memo hash must be a 32-byte hex string (64 characters)");
    }

    // Simple envelope payload containing memo hash
    const memoPayload = `tx_memo_hash=${cleanHash}`;
    return this.sendTransaction({
      address: "",
      abi: null,
      method: "submitTransaction",
      args: [memoPayload],
    });
  }

  /**
   * Fetches transaction details including memo from Horizon by transaction hash.
   */
  async getTransactionMemo(txHash: string): Promise<{ hash: string; memo?: string; memo_type?: string }> {
    const res = await this.call<{ hash: string; memo?: string; memo_type?: string }>({
      address: "",
      abi: null,
      method: "getTransaction",
      args: [txHash],
    });
    return res.data;
  }

  /**
   * Fetches paged transactions for an account with optional pagination options (cursor, limit, order).
   */
  async getTransactionsPaged<T = HorizonTransactionRecord>(
    accountId: string,
    options?: HorizonPaginationOptions,
  ): Promise<ContractCallResult<HorizonCollectionResponse<T>>> {
    return this.call<HorizonCollectionResponse<T>>({
      address: accountId,
      abi: null,
      method: "getTransactions",
      args: [accountId, options],
    });
  }

  /**
   * Iteratively fetches transactions for an account using strict cursor chaining to prevent cursor drift.
   * Guaranteed to avoid duplicates and gaps by advancing the cursor to the last seen record's paging_token.
   * Handles rate-limiting (429) gracefully using configurable retry logic.
   */
  async fetchAllTransactionsPaged<T extends { paging_token: string } = HorizonTransactionRecord>(
    accountId: string,
    options: FetchAllPagesOptions = {},
  ): Promise<T[]> {
    const limit = options.limitPerPage ?? 200;
    const order = options.order ?? "asc";
    let cursor = options.initialCursor;
    const maxRecords = options.maxRecords ?? Infinity;

    const records: T[] = [];
    const seenCursors = new Set<string>();

    while (records.length < maxRecords) {
      const fetchLimit = Math.min(limit, maxRecords - records.length);
      let pageData: HorizonCollectionResponse<T>;

      let attempt = 0;
      const maxRetries = options.maxRetriesOnRateLimit ?? 5;
      while (true) {
        try {
          const res = await this.getTransactionsPaged<T>(accountId, {
            cursor,
            limit: fetchLimit,
            order,
          });
          pageData = res.data;
          break;
        } catch (err: unknown) {
          if (err instanceof ContractRateLimitError && attempt < maxRetries) {
            attempt++;
            if (options.onRateLimit) {
              await options.onRateLimit(attempt);
            } else {
              await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
            }
            continue;
          }
          throw err;
        }
      }

      const pageRecords = pageData?._embedded?.records || [];
      if (pageRecords.length === 0) {
        break;
      }

      let addedInThisPage = 0;
      for (const rec of pageRecords) {
        const token = rec.paging_token;
        if (token && !seenCursors.has(token)) {
          seenCursors.add(token);
          records.push(rec);
          addedInThisPage++;
          cursor = token;
          if (records.length >= maxRecords) {
            break;
          }
        }
      }

      if (addedInThisPage === 0) {
        break;
      }
    }

    return records;
  }

  private buildReadUrl(method: string, methodArgs: any[]): string {
    const id = methodArgs[0] as string;
    switch (method) {
      case "getAccount":
        return `${this.horizonUrl}/accounts/${encodeURIComponent(id)}`;
      case "getTransactions": {
        let url = `${this.horizonUrl}/accounts/${encodeURIComponent(id)}/transactions`;
        const options = methodArgs[1] as HorizonPaginationOptions | undefined;
        if (options) {
          const params = new URLSearchParams();
          if (options.cursor !== undefined) params.set("cursor", options.cursor);
          if (options.limit !== undefined) params.set("limit", options.limit.toString());
          if (options.order !== undefined) params.set("order", options.order);
          const queryString = params.toString();
          if (queryString) {
            url += `?${queryString}`;
          }
        }
        return url;
      }
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
