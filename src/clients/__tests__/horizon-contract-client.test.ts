import { jest } from "@jest/globals";
import { HorizonContractClient, HorizonHttpError } from "../../clients/horizon-contract-client.js";
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
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

function mockHttpError(status: number, body = "") {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response);
}

function mockNetworkError(message = "network failure") {
  mockFetch.mockRejectedValueOnce(new Error(message));
}

function mockMalformedJson() {
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
