import { jest } from "@jest/globals";
import {
  HorizonContractClient,
  HorizonHttpError,
  _clearTokenBuckets,
} from "../../clients/horizon-contract-client.js";
import { ContractService } from "../../services/contract.service.js";
import { RetryPolicy } from "../../utils/retry-policy.js";
import { ContractExecutionError } from "../../errors/contractErrors.js";

/**
 * Focused regression coverage for the two "Horizon returned malformed JSON
 * response" failure paths in `horizon-contract-client.ts`:
 *
 * - line ~696 — `getTransactionFinality()` probes Horizon directly, so the
 *   error is thrown raw and is NOT reclassified by `mapContractError`.
 * - line ~1246 — the shared `fetchJson()` used by `call()` / `sendTransaction()`,
 *   where the same message is mapped to `ContractExecutionError`.
 *
 * The existing suite covers the `call()`/`getAccount` route; this file pins the
 * direct-probe route and the confirmation-math boundaries.
 */

const BASE_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";

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

const mockFetch = jest.fn<any>();
global.fetch = mockFetch as unknown as typeof fetch;

function mockOk(body: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function mockHttpError(status: number, body = "") {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response);
}

function mockMalformedJson() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
    text: async () => "not-json",
  } as unknown as Response);
}

beforeEach(() => {
  mockFetch.mockReset();
  _clearTokenBuckets();
});

describe("HorizonContractClient.getTransactionFinality()", () => {
  it("reports { found: false } for a 404 instead of throwing", async () => {
    mockHttpError(404);

    const status = await makeClient().getTransactionFinality("missing-tx", {
      latestLedger: 42,
    });

    expect(status.found).toBe(false);
    expect(status.txHash).toBe("missing-tx");
    expect(status.confirmations).toBe(0);
  });

  it("throws the raw malformed-JSON error message", async () => {
    mockMalformedJson();

    await expect(
      makeClient().getTransactionFinality("tx-1", { latestLedger: 100 }),
    ).rejects.toThrow("Horizon returned malformed JSON response");
  });

  it("does not reclassify the direct-probe malformed-JSON error", async () => {
    mockMalformedJson();

    const error = await makeClient()
      .getTransactionFinality("tx-2", { latestLedger: 100 })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ContractExecutionError);
    expect((error as Error).message).toBe("Horizon returned malformed JSON response");
  });

  it("reports one confirmation when the transaction is in the latest ledger", async () => {
    mockOk({ ledger: 100, successful: true });

    const status = await makeClient().getTransactionFinality("tx-3", {
      latestLedger: 100,
    });

    expect(status).toEqual({
      found: true,
      txHash: "tx-3",
      successful: true,
      ledger: 100,
      latestLedger: 100,
      confirmations: 1,
    });
  });

  it("derives confirmations as latestLedger - ledger + 1", async () => {
    mockOk({ ledger: 98, successful: true });

    const status = await makeClient().getTransactionFinality("tx-4", {
      latestLedger: 105,
    });

    expect(status.confirmations).toBe(8);
  });

  it("clamps confirmations to zero when the ledger is ahead of the reported latest", async () => {
    mockOk({ ledger: 200, successful: true });

    const status = await makeClient().getTransactionFinality("tx-5", {
      latestLedger: 100,
    });

    expect(status.confirmations).toBe(0);
  });

  it("returns zero confirmations and no ledger when the field is absent", async () => {
    mockOk({ successful: false });

    const status = await makeClient().getTransactionFinality("tx-6", {
      latestLedger: 100,
    });

    expect(status.found).toBe(true);
    expect(status.successful).toBe(false);
    expect(status.ledger).toBeUndefined();
    expect(status.confirmations).toBe(0);
  });

  it("fetches the latest ledger itself when latestLedger is omitted", async () => {
    mockOk({ _embedded: { records: [{ sequence: 100 }] } });
    mockOk({ ledger: 98, successful: true });

    const status = await makeClient().getTransactionFinality("tx-7");

    expect(status.latestLedger).toBe(100);
    expect(status.confirmations).toBe(3);
  });

  it("throws a HorizonHttpError for a non-404 HTTP failure", async () => {
    mockHttpError(500, "upstream exploded");

    const error = await makeClient()
      .getTransactionFinality("tx-8", { latestLedger: 10 })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(HorizonHttpError);
    expect((error as HorizonHttpError).statusCode).toBe(500);
  });

  it("URL-encodes the transaction hash in the probe request", async () => {
    mockOk({ successful: true });

    await makeClient().getTransactionFinality("abc/123", { latestLedger: 1 });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/transactions/${encodeURIComponent("abc/123")}`),
      expect.anything(),
    );
  });
});

describe("HorizonContractClient.getLatestLedgerSequence()", () => {
  it("maps malformed JSON from the retried call() route to ContractExecutionError", async () => {
    mockMalformedJson();

    await expect(makeClient().getLatestLedgerSequence()).rejects.toBeInstanceOf(
      ContractExecutionError,
    );
  });
});
