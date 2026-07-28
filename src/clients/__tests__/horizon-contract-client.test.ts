import { jest } from "@jest/globals";
import {
  HorizonContractClient,
  HorizonHttpError,
  HorizonInsufficientBalanceError,
  computeMinBalance,
} from "../../clients/horizon-contract-client.js";
import { ContractService } from "../../services/contract.service.js";
import { RetryPolicy } from "../../utils/retry-policy.js";
import {
  ContractExecutionError,
  ContractInvalidRequestError,
  ContractProviderUnavailableError,
  ContractRateLimitError,
} from "../../errors/contractErrors.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const ACCOUNT_ID = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const TX_HASH = "abc123";
const XDR = "AAAAAQAAAA==";

function makeService(): ContractService {
  return new ContractService(
    new RetryPolicy({ maxRetries: 0, initialDelay: 0, backoffFactor: 1, maxDelay: 0, useJitter: false }),
  );
}

function makeClient(url = BASE_URL): HorizonContractClient {
  return new HorizonContractClient(url, PASSPHRASE, makeService());
}

function args(method: string, ...methodArgs: any[]) {
  return { address: ACCOUNT_ID, abi: null, method, args: methodArgs };
}

// ─── fetch mock ───────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockOk(body: unknown) {
  // @ts-expect-error - Auto-fixed by script
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

function mockHttpError(status: number, body = "") {
  // @ts-expect-error - Auto-fixed by script
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response);
}

function mockNetworkError(message = "network failure") {
  // @ts-expect-error - Auto-fixed by script
  mockFetch.mockRejectedValueOnce(new Error(message));
}

function mockMalformedJson() {
  // @ts-expect-error - Auto-fixed by script
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => { throw new SyntaxError("Unexpected token"); },
    text: async () => "not-json",
  } as unknown as Response);
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ─── HorizonHttpError ─────────────────────────────────────────────────────────

describe("HorizonHttpError", () => {
  it("stores statusCode and truncates long body", () => {
    const body = "x".repeat(300);
    const err = new HorizonHttpError(503, body);
    expect(err.statusCode).toBe(503);
    expect(err.message.length).toBeLessThan(300);
    expect(err.name).toBe("HorizonHttpError");
  });

  it("computes minimum balance for zero subentries and many trustlines", () => {
    expect(computeMinBalance(0, 5_000_000)).toBe(10_000_000);
    expect(computeMinBalance(42, 5_000_000)).toBe(220_000_000);
  });

  it("rejects payouts that would breach the minimum reserve by one stroop", async () => {
    const client = makeClient();
    mockOk({
      id: ACCOUNT_ID,
      subentry_count: 2,
      balances: [{ asset_type: "native", balance: "1.0000000" }],
    });

    await expect(
      client.submitPayout(ACCOUNT_ID, XDR, { baseReserve: 5_000_000, subentries: 2, amount: "1.0000000" }),
    ).rejects.toBeInstanceOf(HorizonInsufficientBalanceError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("allows payouts when the account balance is exactly at the minimum reserve", async () => {
    const client = makeClient();
    mockOk({
      id: ACCOUNT_ID,
      subentry_count: 2,
      balances: [{ asset_type: "native", balance: "2.0000000" }],
    });
    mockOk({ hash: TX_HASH });

    await expect(client.submitPayout(ACCOUNT_ID, XDR, { baseReserve: 5_000_000, subentries: 2 })).resolves.toEqual(
      expect.objectContaining({ hash: TX_HASH }),
    );
  });

  it("includes trustlines and offers in the effective reserve calculation", async () => {
    const client = makeClient();
    mockOk({
      id: ACCOUNT_ID,
      subentry_count: 2,
      balances: [{ asset_type: "native", balance: "19.0000000" }],
    });
    mockOk({ hash: TX_HASH });

    await expect(
      client.submitPayout(ACCOUNT_ID, XDR, {
        baseReserve: 5_000_000,
        subentries: 2,
        trustlines: 30,
        offers: 4,
        amount: "0",
      }),
    ).resolves.toEqual(expect.objectContaining({ hash: TX_HASH }));
  });

  it("5xx message contains 'service unavailable'", () => {
    expect(new HorizonHttpError(500, "err").message).toContain("service unavailable");
    expect(new HorizonHttpError(503, "err").message).toContain("service unavailable");
  });

  it("429 message contains 'rate limit'", () => {
    expect(new HorizonHttpError(429, "err").message).toContain("rate limit");
  });

  it("4xx message contains 'invalid argument'", () => {
    expect(new HorizonHttpError(400, "err").message).toContain("invalid argument");
    expect(new HorizonHttpError(404, "err").message).toContain("invalid argument");
  });
});

// ─── call() ───────────────────────────────────────────────────────────────────

describe("HorizonContractClient.call()", () => {
  it("getAccount fetches /accounts/:id and returns data with blockNumber 0", async () => {
    const account = { id: ACCOUNT_ID, sequence: "1" };
    mockOk(account);

    const client = makeClient();
    const result = await client.call(args("getAccount", ACCOUNT_ID));

    expect(result.data).toEqual(account);
    expect(result.blockNumber).toBe(0);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/accounts/${ACCOUNT_ID}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("getTransactions fetches /accounts/:id/transactions", async () => {
    const txList = { _embedded: { records: [] } };
    mockOk(txList);

    const client = makeClient();
    await client.call(args("getTransactions", ACCOUNT_ID));

    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/accounts/${ACCOUNT_ID}/transactions`,
      expect.anything(),
    );
  });

  it("getTransactions formats cursor, limit, and order query parameters", async () => {
    const txList = { _embedded: { records: [] } };
    mockOk(txList);

    const client = makeClient();
    await client.getTransactionsPaged(ACCOUNT_ID, { cursor: "100", limit: 50, order: "asc" });

    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/accounts/${ACCOUNT_ID}/transactions?cursor=100&limit=50&order=asc`,
      expect.anything(),
    );
  });

  it("fetchAllTransactionsPaged aggregates records using cursor chaining", async () => {
    const page1 = {
      _embedded: {
        records: [
          { id: "1", paging_token: "100", hash: "h1" },
          { id: "2", paging_token: "101", hash: "h2" },
        ],
      },
    };
    const page2 = {
      _embedded: {
        records: [
          { id: "3", paging_token: "102", hash: "h3" },
        ],
      },
    };
    const page3 = { _embedded: { records: [] } };

    mockOk(page1);
    mockOk(page2);
    mockOk(page3);

    const client = makeClient();
    const records = await client.fetchAllTransactionsPaged(ACCOUNT_ID, { limitPerPage: 2 });

    expect(records).toHaveLength(3);
    expect(records.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("fetchAllTransactionsPaged handles 429 rate limit retry", async () => {
    mockHttpError(429, "rate limit");
    const page = {
      _embedded: {
        records: [{ id: "1", paging_token: "100", hash: "h1" }],
      },
    };
    mockOk(page);
    const emptyPage = { _embedded: { records: [] } };
    mockOk(emptyPage);

    const client = makeClient();
    let rateLimitCalls = 0;
    const records = await client.fetchAllTransactionsPaged(ACCOUNT_ID, {
      maxRetriesOnRateLimit: 2,
      onRateLimit: async (attempt) => {
        rateLimitCalls = attempt;
      },
    });

    expect(rateLimitCalls).toBe(1);
    expect(records).toHaveLength(1);
  });

  it("fetchAllTransactionsPaged uses default rate limit delay when onRateLimit callback is omitted", async () => {
    mockHttpError(429, "rate limit");
    mockOk({ _embedded: { records: [{ id: "1", paging_token: "100", hash: "h1" }] } });
    mockOk({ _embedded: { records: [] } });

    const client = makeClient();
    const records = await client.fetchAllTransactionsPaged(ACCOUNT_ID, {
      maxRetriesOnRateLimit: 1,
    });
    expect(records).toHaveLength(1);
  });

  it("fetchAllTransactionsPaged stops immediately when maxRecords limit is reached inside page loop", async () => {
    mockOk({
      _embedded: {
        records: [
          { id: "1", paging_token: "100", hash: "h1" },
          { id: "2", paging_token: "101", hash: "h2" },
        ],
      },
    });

    const client = makeClient();
    const records = await client.fetchAllTransactionsPaged(ACCOUNT_ID, {
      maxRecords: 1,
    });
    expect(records).toHaveLength(1);
  });

  it("fetchAllTransactionsPaged breaks when no new unique records are added in a page", async () => {
    mockOk({
      _embedded: {
        records: [{ id: "1", paging_token: "100", hash: "h1" }],
      },
    });
    mockOk({
      _embedded: {
        records: [{ id: "1", paging_token: "100", hash: "h1" }],
      },
    });

    const client = makeClient();
    const records = await client.fetchAllTransactionsPaged(ACCOUNT_ID);
    expect(records).toHaveLength(1);
  });

  it("getLatestLedger fetches /ledgers?limit=1&order=desc", async () => {
    mockOk({ _embedded: { records: [] } });
    const client = makeClient();
    await client.call(args("getLatestLedger", ""));
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/ledgers?limit=1&order=desc`,
      expect.anything(),
    );
  });

  it("getTransaction fetches /transactions/:hash", async () => {
    const tx = { hash: TX_HASH };
    mockOk(tx);

    const client = makeClient();
    await client.call(args("getTransaction", TX_HASH));

    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/transactions/${TX_HASH}`,
      expect.anything(),
    );
  });

  it("strips trailing slash from base URL", async () => {
    mockOk({ id: ACCOUNT_ID });
    const client = makeClient(`${BASE_URL}/`);
    await client.call(args("getAccount", ACCOUNT_ID));
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/accounts/${ACCOUNT_ID}`,
      expect.anything(),
    );
  });

  it("throws ContractInvalidRequestError for unknown method", async () => {
    const client = makeClient();
    await expect(client.call(args("unknownMethod", ACCOUNT_ID))).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("maps 404 to ContractInvalidRequestError", async () => {
    mockHttpError(404, "not found");
    const client = makeClient();
    await expect(client.call(args("getAccount", ACCOUNT_ID))).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
  });

  it("maps 429 to ContractRateLimitError", async () => {
    mockHttpError(429, "rate limit");
    const client = makeClient();
    await expect(client.call(args("getAccount", ACCOUNT_ID))).rejects.toBeInstanceOf(
      ContractRateLimitError,
    );
  });

  it("maps 503 to ContractProviderUnavailableError", async () => {
    mockHttpError(503, "service unavailable");
    const client = makeClient();
    await expect(client.call(args("getAccount", ACCOUNT_ID))).rejects.toBeInstanceOf(
      ContractProviderUnavailableError,
    );
  });

  it("maps 500 to ContractProviderUnavailableError", async () => {
    mockHttpError(500, "internal server error");
    const client = makeClient();
    await expect(client.call(args("getAccount", ACCOUNT_ID))).rejects.toBeInstanceOf(
      ContractProviderUnavailableError,
    );
  });

  it("maps 502 to ContractProviderUnavailableError", async () => {
    mockHttpError(502, "bad gateway");
    const client = makeClient();
    await expect(client.call(args("getAccount", ACCOUNT_ID))).rejects.toBeInstanceOf(
      ContractProviderUnavailableError,
    );
  });

  it("maps network error to AppError", async () => {
    mockNetworkError("ECONNRESET");
    const client = makeClient();
    await expect(client.call(args("getAccount", ACCOUNT_ID))).rejects.toBeInstanceOf(Error);
  });

  it("maps malformed JSON to ContractExecutionError", async () => {
    mockMalformedJson();
    const client = makeClient();
    await expect(client.call(args("getAccount", ACCOUNT_ID))).rejects.toBeInstanceOf(
      ContractExecutionError,
    );
  });

  it("URL-encodes special characters in account id", async () => {
    mockOk({});
    const client = makeClient();
    const specialId = "GA+TEST/ID";
    await client.call(args("getAccount", specialId));
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(specialId)),
      expect.anything(),
    );
  });

  it("getLatestLedger fetches /ledgers?limit=1&order=desc", async () => {
    const ledger = { _embedded: { records: [{ sequence: 100 }] } };
    mockOk(ledger);
    const client = makeClient();
    const result = await client.call(args("getLatestLedger", ""));
    expect(result.data).toEqual(ledger);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/ledgers?limit=1&order=desc`,
      expect.anything(),
    );
  });
});

// ─── sendTransaction() ────────────────────────────────────────────────────────

describe("HorizonContractClient.sendTransaction()", () => {
  it("POSTs XDR to /transactions and returns hash", async () => {
    mockOk({ hash: TX_HASH });

    const client = makeClient();
    const result = await client.sendTransaction(args("submitTransaction", XDR));

    expect(result.hash).toBe(TX_HASH);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/transactions`,
      expect.objectContaining({
        method: "POST",
        body: `tx=${encodeURIComponent(XDR)}`,
      }),
    );
  });

  it("sets Content-Type to application/x-www-form-urlencoded", async () => {
    mockOk({ hash: TX_HASH });
    const client = makeClient();
    await client.sendTransaction(args("submitTransaction", XDR));
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      }),
    );
  });

  it("wait() fetches /transactions/:hash", async () => {
    mockOk({ hash: TX_HASH });
    const txDetail = { hash: TX_HASH, ledger: 42 };
    mockOk(txDetail);

    const client = makeClient();
    const result = await client.sendTransaction(args("submitTransaction", XDR));
    const detail = await result.wait();

    expect(detail).toEqual(txDetail);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/transactions/${TX_HASH}`,
      expect.anything(),
    );
  });

  it("maps 400 submission error to ContractInvalidRequestError", async () => {
    mockHttpError(400, "Transaction malformed");
    const client = makeClient();
    await expect(client.sendTransaction(args("submitTransaction", XDR))).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
  });

  it("maps 503 submission error to ContractProviderUnavailableError", async () => {
    mockHttpError(503, "service unavailable");
    const client = makeClient();
    await expect(client.sendTransaction(args("submitTransaction", XDR))).rejects.toBeInstanceOf(
      ContractProviderUnavailableError,
    );
  });

  it("maps network error during submission to AppError", async () => {
    mockNetworkError("ETIMEDOUT");
    const client = makeClient();
    await expect(client.sendTransaction(args("submitTransaction", XDR))).rejects.toBeInstanceOf(Error);
  });

  it("submitMemoTransaction validates memo hash format and posts to Horizon", async () => {
    const client = makeClient();
    const invalidHash = "12345";
    await expect(client.submitMemoTransaction(invalidHash)).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );

    const validHash = "ab".repeat(32);
    mockOk({ hash: TX_HASH });

    const res = await client.submitMemoTransaction(validHash);
    expect(res.hash).toBe(TX_HASH);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/transactions`,
      expect.objectContaining({
        method: "POST",
        body: `tx=${encodeURIComponent(`tx_memo_hash=${validHash}`)}`,
      }),
    );
  });

  it("getTransactionMemo fetches transaction details including memo by tx hash", async () => {
    const client = makeClient();
    const memoHash = "cd".repeat(32);
    mockOk({ hash: TX_HASH, memo: memoHash, memo_type: "hash" });

    const txData = await client.getTransactionMemo(TX_HASH);
    expect(txData.hash).toBe(TX_HASH);
    expect(txData.memo).toBe(memoHash);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/transactions/${TX_HASH}`,
      expect.anything(),
    );
  });
});

// ─── Fee-bump validation path (issue #436) ─────────────────────

import {
  TEST_DEST_KEY,
  TEST_FEE_SOURCE_KEY,
  TX_FEE,
  TX_SEQ_NUM,
  buildFeeBumpEnvelope,
  concatBuffers,
  defaultFeeBumpEnvelope,
  defaultRegularEnvelope,
  hexToBytes,
  int64BE,
  makePaymentOperation,
  makeTestSig,
  paddedKey,
  toBase64Xdr,
  uint32BE,
} from "./fee-bump-fixtures.js";
import { ENVELOPE_TYPE_FEE_BUMP, ENVELOPE_TYPE_TX, KEY_TYPE_ED25519 } from "../fee-bump-validator.js";

describe("HorizonContractClient.sendTransaction() — fee-bump validation (issue #436)", () => {
  it("posts a valid fee-bump envelope to /transactions", async () => {
    mockOk({ hash: TX_HASH });

    const client = makeClient();
    const xdr = defaultFeeBumpEnvelope();
    const result = await client.sendTransaction(args("submitTransaction", xdr));

    expect(result.hash).toBe(TX_HASH);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/transactions`,
      expect.objectContaining({ method: "POST" }),
    );

    const calledArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const calledBody = (calledArgs[1].body ?? "") as string;
    expect(calledBody).toContain(`tx=${encodeURIComponent(xdr)}`);
  });

  it("posts a regular (non-fee-bump) envelope without invoking the validator", async () => {
    mockOk({ hash: TX_HASH });

    const client = makeClient();
    await client.sendTransaction(args("submitTransaction", defaultRegularEnvelope()));

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a fee-bump envelope where sponsor == inner source (no fetch)", async () => {
    const xdr = buildFeeBumpEnvelope(
      TEST_FEE_SOURCE_KEY,
      BigInt(1000),
      TEST_FEE_SOURCE_KEY, // INTENTIONALLY same as sponsor
      TX_FEE,
      TX_SEQ_NUM,
      makePaymentOperation(TEST_DEST_KEY, BigInt(100)),
      [makeTestSig()],
      [makeTestSig()],
    );

    const client = makeClient();
    await expect(client.sendTransaction(args("submitTransaction", xdr))).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
    // fetch MUST NOT be called — validation happens before the HTTP POST.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a fee-bump envelope with no inner signatures (no fetch)", async () => {
    const xdr = defaultFeeBumpEnvelope(BigInt(1000), [], [makeTestSig()]);

    const client = makeClient();
    await expect(client.sendTransaction(args("submitTransaction", xdr))).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a fee-bump envelope with a zero fee (no fetch)", async () => {
    const xdr = defaultFeeBumpEnvelope(BigInt(0));

    const client = makeClient();
    await expect(client.sendTransaction(args("submitTransaction", xdr))).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a fee-bump envelope whose inner envelope type is unsupported (no fetch)", async () => {
    // Construct a fee-bump shell where inner-envelope-type is not 1 (Tx) or 4 (FeeBump).
    const buf = concatBuffers(
      uint32BE(ENVELOPE_TYPE_FEE_BUMP),
      paddedKey(TEST_FEE_SOURCE_KEY),
      int64BE(BigInt(1000)),
      uint32BE(2),
    );
    const xdr = toBase64Xdr(Array.from(buf));

    const client = makeClient();
    await expect(client.sendTransaction(args("submitTransaction", xdr))).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not invoke the validator for an XDR whose envelope type is not 4", async () => {
    // Regular tx envelopes must pass straight through to Horizon — the validator
    // is fee-bump-scoped.
    const header = concatBuffers(
      uint32BE(ENVELOPE_TYPE_TX),
      paddedKey(TEST_FEE_SOURCE_KEY),
      int64BE(BigInt(0)), // would be rejected as a fee-bump fee, but we are not in fee-bump scope
    );
    const malformed = toBase64Xdr(Array.from(header));

    mockHttpError(400, "bad request");

    const client = makeClient();
    await expect(client.sendTransaction(args("submitTransaction", malformed))).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
    // The ContractInvalidRequestError came from Horizon's HTTP 400 mapping, not from the validator.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("isFeeBumpTransaction heuristic ignores XDR that is too short to read", async () => {
    // Less than 4 bytes — the client must NOT throw and must NOT attempt to validate
    // a fee-bump envelope; it should just route the bad XDR to Horizon (which will reject).
    const shortB64 = Buffer.from([0x00, 0x00]).toString("base64");
    mockHttpError(400, "bad request");

    const client = makeClient();
    await expect(client.sendTransaction(args("submitTransaction", shortB64))).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("isFeeBumpTransaction returns false if Buffer.from throws an exception", async () => {
    jest.spyOn(Buffer, "from").mockImplementationOnce(() => {
      throw new Error("Buffer conversion error");
    });
    mockHttpError(400, "bad request");

    const client = makeClient();
    await expect(client.sendTransaction(args("submitTransaction", "trigger-error"))).rejects.toBeInstanceOf(
      ContractInvalidRequestError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── Circuit breaker integration ─────────────────────────────────────────────

describe("circuit breaker integration", () => {
  it("opens circuit after 5 consecutive 5xx failures", async () => {
    // Use real ContractService with fast retry policy (0 retries)
    const service = new ContractService(
      new RetryPolicy({ maxRetries: 0, initialDelay: 0, backoffFactor: 1, maxDelay: 0, useJitter: false }),
    );
    const client = new HorizonContractClient(BASE_URL, PASSPHRASE, service);

    for (let i = 0; i < 5; i++) {
      mockHttpError(503, "service unavailable");
      await expect(client.call(args("getAccount", ACCOUNT_ID))).rejects.toThrow();
    }

    // 6th call should be blocked by circuit breaker (no fetch call)
    await expect(client.call(args("getAccount", ACCOUNT_ID))).rejects.toBeInstanceOf(
      ContractProviderUnavailableError,
    );
    // fetch was called exactly 5 times (circuit blocked the 6th)
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});

// ─── Partial Refund Stellar Path Payment & FX Slippage Protection (Issue #477) ──

describe("HorizonContractClient.findPathPaymentQuote()", () => {
  const nativeAsset = { asset_type: "native" as const };
  const usdcAsset = {
    asset_type: "credit_alphanum4" as const,
    asset_code: "USDC",
    asset_issuer: "GA5ZSEJYB37JRC5AVCIA5XY24DZ36LAK5C4AWM4C6NRPCHCYK3DYB7K5",
  };

  it("calculates min-received guard and returns quote for valid path payment", async () => {
    const client = makeClient();
    mockOk({
      _embedded: {
        records: [
          {
            source_asset_type: "native",
            source_amount: "100.0000000",
            destination_asset_type: "credit_alphanum4",
            destination_asset_code: "USDC",
            destination_asset_issuer: usdcAsset.asset_issuer,
            destination_amount: "10.0000000",
            path: [],
          },
        ],
      },
    });

    const quote = await client.findPathPaymentQuote({
      sourceAsset: nativeAsset,
      sourceAmount: 1000000000, // 100 XLM in stroops
      destinationAsset: usdcAsset,
      maxSlippageTolerancePercent: 0.5,
      tenantId: "tenant-1",
    });

    expect(quote.tenantId).toBe("tenant-1");
    expect(quote.sourceAmount).toBe("100.0000000");
    expect(quote.destinationAmount).toBe("10.0000000");
    // 10.0 * (1 - 0.005) = 9.95
    expect(quote.minDestinationAmount).toBe("9.9500000");
    expect(quote.maxSlippageTolerancePercent).toBe(0.5);
  });

  it("throws ContractInvalidRequestError when source amount is a dust amount", async () => {
    const client = makeClient();
    await expect(
      client.findPathPaymentQuote({
        sourceAsset: nativeAsset,
        sourceAmount: 50, // Below default dust threshold of 100
        destinationAsset: usdcAsset,
      }),
    ).rejects.toThrow("below minimum threshold");
  });

  it("throws ContractInvalidRequestError when oracle timestamp is stale", async () => {
    const client = makeClient();
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600; // 600s old (max age 300s)

    await expect(
      client.findPathPaymentQuote({
        sourceAsset: nativeAsset,
        sourceAmount: 1000000,
        destinationAsset: usdcAsset,
        oracleTimestamp: staleTimestamp,
        oracleMaxAgeSeconds: 300,
      }),
    ).rejects.toThrow("Stale oracle rate");
  });

  it("throws ContractInvalidRequestError when no path is found by Horizon", async () => {
    const client = makeClient();
    mockOk({ _embedded: { records: [] } });

    await expect(
      client.findPathPaymentQuote({
        sourceAsset: nativeAsset,
        sourceAmount: 1000000,
        destinationAsset: usdcAsset,
      }),
    ).rejects.toThrow("No path found for Stellar path payment");
  });

  it("throws ContractInvalidRequestError when quoted slippage exceeds tolerance", async () => {
    const client = makeClient();
    // Quoted rate: 5 USDC / 100 XLM = 0.05
    mockOk({
      _embedded: {
        records: [
          {
            source_asset_type: "native",
            source_amount: "100.0000000",
            destination_asset_type: "credit_alphanum4",
            destination_asset_code: "USDC",
            destination_asset_issuer: usdcAsset.asset_issuer,
            destination_amount: "5.0000000",
            path: [],
          },
        ],
      },
    });

    // Oracle expects 0.1 USDC per XLM (10 USDC for 100 XLM)
    await expect(
      client.findPathPaymentQuote({
        sourceAsset: nativeAsset,
        sourceAmount: "100.0000000",
        destinationAsset: usdcAsset,
        oracleRate: 0.1,
        maxSlippageTolerancePercent: 1.0, // 1% tolerance, but actual slippage is 50%
      }),
    ).rejects.toThrow("Slippage tolerance exceeded");
  });
});
