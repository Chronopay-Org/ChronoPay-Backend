import { jest } from "@jest/globals";
import {
  HorizonContractClient,
  HorizonHttpError,
} from "../horizon-contract-client.js";
import { ContractService } from "../../services/contract.service.js";
import { RetryPolicy } from "../../utils/retry-policy.js";
import {
  ContractSequenceCollisionError,
  ContractInvalidRequestError,
  ContractProviderUnavailableError,
} from "../../errors/contractErrors.js";

const BASE_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const ACCOUNT_ID = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const TX_HASH = "abc123";
const XDR = "AAAAAQAAAA==";

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

function mockJsonRpcError(status: number, body: string) {
  // @ts-expect-error - Auto-fixed by script
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => body,
  } as unknown as Response);
}

function makeClient(): HorizonContractClient {
  const service = new ContractService(
    new RetryPolicy({ maxRetries: 0, initialDelay: 0, backoffFactor: 1, maxDelay: 0, useJitter: false }),
  );
  return new HorizonContractClient(BASE_URL, PASSPHRASE, service);
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ─── Error Classification ─────────────────────────────────────────────────────

describe("tx_bad_seq error classification", () => {
  it("maps tx_bad_seq Horizon HTTP 400 to ContractSequenceCollisionError", async () => {
    mockJsonRpcError(400, JSON.stringify({
      type: "https://stellar.org/horizon-errors/transaction_failed",
      title: "Transaction Failed",
      status: 400,
      detail: "tx_bad_seq",
      extras: { result_codes: { transaction: "tx_bad_seq" } },
    }));

    const client = makeClient();
    await expect(
      client.sendTransaction({
        address: ACCOUNT_ID,
        abi: null,
        method: "submitTransaction",
        args: [XDR],
      }),
    ).rejects.toBeInstanceOf(ContractSequenceCollisionError);
  });

  it("maps bad sequence text in error body to ContractSequenceCollisionError", async () => {
    mockJsonRpcError(400, "transaction failed: bad sequence number");

    const client = makeClient();
    await expect(
      client.sendTransaction({
        address: ACCOUNT_ID,
        abi: null,
        method: "submitTransaction",
        args: [XDR],
      }),
    ).rejects.toBeInstanceOf(ContractSequenceCollisionError);
  });

  it("maps generic 400 (not sequence-related) to ContractInvalidRequestError", async () => {
    mockJsonRpcError(400, "Transaction malformed");

    const client = makeClient();
    await expect(
      client.sendTransaction({
        address: ACCOUNT_ID,
        abi: null,
        method: "submitTransaction",
        args: [XDR],
      }),
    ).rejects.toBeInstanceOf(ContractInvalidRequestError);
  });
});

// ─── getAccountSequence ───────────────────────────────────────────────────────

describe("getAccountSequence", () => {
  it("fetches the account sequence from Horizon", async () => {
    mockOk({ id: ACCOUNT_ID, sequence: "1234567890" });

    const client = makeClient();
    const sequence = await client.getAccountSequence(ACCOUNT_ID);

    expect(sequence).toBe("1234567890");
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/accounts/${ACCOUNT_ID}`,
      expect.anything(),
    );
  });

  it("returns the sequence as a string matching Horizon format", async () => {
    mockOk({ id: ACCOUNT_ID, sequence: "9999999999999999999" });

    const client = makeClient();
    const sequence = await client.getAccountSequence(ACCOUNT_ID);

    expect(typeof sequence).toBe("string");
    expect(sequence).toBe("9999999999999999999");
  });
});

// ─── sendTransactionWithSequenceRecovery ──────────────────────────────────────

describe("sendTransactionWithSequenceRecovery", () => {
  it("submits successfully on first attempt when no collision", async () => {
    mockOk({ hash: TX_HASH });

    const client = makeClient();
    const result = await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async () => { throw new Error("should not be called"); },
    );

    expect(result.hash).toBe(TX_HASH);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries after tx_bad_seq: re-reads sequence, rebuilds XDR, and succeeds", async () => {
    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "42" });
    mockOk({ hash: TX_HASH });

    let rebuiltSequence = "";
    const client = makeClient();

    const result = await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async (freshSequence) => {
        rebuiltSequence = freshSequence;
        return `REBUILT_XDR_${freshSequence}`;
      },
      { useJitter: false, initialDelayMs: 0 },
    );

    expect(result.hash).toBe(TX_HASH);
    expect(rebuiltSequence).toBe("42");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries multiple times after repeated tx_bad_seq and eventually succeeds", async () => {
    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "10" });

    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "11" });

    mockOk({ hash: TX_HASH });

    const rebuiltSequences: string[] = [];
    const onRetryCalls: { attempt: number; sequence: string }[] = [];

    const client = makeClient();
    const result = await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async (freshSequence) => {
        rebuiltSequences.push(freshSequence);
        return `XDR_${freshSequence}`;
      },
      {
        useJitter: false,
        initialDelayMs: 0,
        onRetry: (attempt, seq) => {
          onRetryCalls.push({ attempt, sequence: seq });
        },
      },
    );

    expect(result.hash).toBe(TX_HASH);
    expect(rebuiltSequences).toEqual(["10", "11"]);
    expect(onRetryCalls).toEqual([
      { attempt: 1, sequence: "10" },
      { attempt: 2, sequence: "11" },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("exhausts retries and throws ContractSequenceCollisionError", async () => {
    for (let i = 0; i < 2; i++) {
      mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
      mockOk({ id: ACCOUNT_ID, sequence: String(i + 1) });
    }
    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));

    const client = makeClient();
    let callCount = 0;

    await expect(
      client.sendTransactionWithSequenceRecovery(
        XDR,
        ACCOUNT_ID,
        async (seq) => {
          callCount++;
          return `XDR_${seq}`;
        },
        { maxRetries: 2, useJitter: false, initialDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ContractSequenceCollisionError);

    expect(callCount).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("does not retry on non-sequence errors", async () => {
    mockJsonRpcError(400, "Transaction malformed");

    const client = makeClient();
    await expect(
      client.sendTransactionWithSequenceRecovery(
        XDR,
        ACCOUNT_ID,
        async () => { throw new Error("should not be called"); },
        { useJitter: false, initialDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ContractInvalidRequestError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 503 provider errors", async () => {
    mockJsonRpcError(503, "service unavailable");

    const client = makeClient();
    await expect(
      client.sendTransactionWithSequenceRecovery(
        XDR,
        ACCOUNT_ID,
        async () => { throw new Error("should not be called"); },
        { useJitter: false, initialDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ContractProviderUnavailableError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("uses backoff delay between retries", async () => {
    const delays: number[] = [];

    // Only capture setTimeout calls that look like recovery delays (not withTimeout abort timers)
    // withTimeout uses a large timeout value (30s+), recovery delays are small (< 1000)
    const origSetTimeout = global.setTimeout.bind(global);
    // @ts-expect-error - Spy replaces setTimeout
    // withTimeout uses 7000ms; recovery backoff delays are small (< 1000)
    const spy = jest.spyOn(global, "setTimeout").mockImplementation((fn: any, delay?: number, ...args: any[]) => {
      if (delay !== undefined && delay > 0 && delay < 5000) {
        delays.push(delay);
      }
      if (delay !== undefined && delay >= 5000) {
        return origSetTimeout(fn, 1, ...args);
      }
      if (typeof fn === "function") {
        fn(...args);
      }
      return 1 as unknown as NodeJS.Timeout;
    });

    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "1" });

    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "2" });

    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "3" });

    mockOk({ hash: TX_HASH });

    const client = makeClient();
    await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async (seq) => `XDR_${seq}`,
      { maxRetries: 3, useJitter: false, initialDelayMs: 10 },
    );

    expect(delays.length).toBe(3);
    expect(delays[0]).toBe(10);
    expect(delays[1]).toBe(20);
    expect(delays[2]).toBe(40);

    spy.mockRestore();
  });

  it("caps delay at 10 seconds", async () => {
    const delays: number[] = [];

    const origSetTimeout = global.setTimeout.bind(global);
    // @ts-expect-error - Spy replaces setTimeout
    const spy = jest.spyOn(global, "setTimeout").mockImplementation((fn: any, delay?: number, ...args: any[]) => {
      if (delay !== undefined && delay > 0 && delay < 50000) {
        delays.push(delay);
      }
      if (delay !== undefined && delay >= 50000) {
        return origSetTimeout(fn, 1, ...args);
      }
      if (typeof fn === "function") {
        fn(...args);
      }
      return 1 as unknown as NodeJS.Timeout;
    });

    for (let i = 0; i < 9; i++) {
      mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
      mockOk({ id: ACCOUNT_ID, sequence: String(i) });
    }
    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));

    const client = makeClient();
    await expect(
      client.sendTransactionWithSequenceRecovery(
        XDR,
        ACCOUNT_ID,
        async (seq) => `XDR_${seq}`,
        { maxRetries: 9, useJitter: false, initialDelayMs: 100 },
      ),
    ).rejects.toBeInstanceOf(ContractSequenceCollisionError);

    // Filter recovery delays (these are < 50000, unlike withTimeout's 7000ms which is also < 50000)
    // Backoff: 100, 200, 400, 800, 1600, 3200, 6400, 10000, 10000
    // withTimeout: 7000 x 19 calls = many 7000 entries
    // Just check that no recovery delay exceeds 10000
    const recoveryDelays = delays.filter((d) => d !== 7000);
    for (const d of recoveryDelays) {
      expect(d).toBeLessThanOrEqual(10000);
    }

    spy.mockRestore();
  });

  it("applies jitter when useJitter is true", async () => {
    const delays: number[] = [];

    const origSetTimeout = global.setTimeout.bind(global);
    // @ts-expect-error - Spy replaces setTimeout
    // Jitter values are < 200 for initialDelayMs:100; withTimeout is 7000ms
    const spy = jest.spyOn(global, "setTimeout").mockImplementation((fn: any, delay?: number, ...args: any[]) => {
      if (delay !== undefined && delay > 0 && delay < 5000) {
        delays.push(delay);
      }
      if (delay !== undefined && delay >= 5000) {
        return origSetTimeout(fn, 1, ...args);
      }
      if (typeof fn === "function") {
        fn(...args);
      }
      return 1 as unknown as NodeJS.Timeout;
    });

    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "5" });

    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "6" });

    mockOk({ hash: TX_HASH });

    const client = makeClient();
    await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async (seq) => `XDR_${seq}`,
      { maxRetries: 3, useJitter: true, initialDelayMs: 100 },
    );

    expect(delays.length).toBe(2);
    expect(delays[0]).toBeGreaterThanOrEqual(0);
    expect(delays[0]).toBeLessThan(100);
    expect(delays[1]).toBeGreaterThanOrEqual(0);
    expect(delays[1]).toBeLessThan(200);

    spy.mockRestore();
  });
});

// ─── Concurrent Submitters Simulation ─────────────────────────────────────────

describe("concurrent submitters race simulation", () => {
  it("recovers when loser re-reads sequence and retries with rebuilt XDR", async () => {
    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "100" });
    mockOk({ hash: TX_HASH });

    const client = makeClient();

    let rebuilt = false;
    const result = await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async (freshSeq) => {
        rebuilt = true;
        expect(freshSeq).toBe("100");
        return `REBUILT_WITH_${freshSeq}`;
      },
      { useJitter: false, initialDelayMs: 0 },
    );

    expect(result.hash).toBe(TX_HASH);
    expect(rebuilt).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("handles both submitters colliding and recovering concurrently", async () => {
    let submissionCount = 0;
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input.toString();

      if (urlStr.includes("/accounts/")) {
        return {
          ok: true,
          json: async () => ({ id: ACCOUNT_ID, sequence: "50" }),
          text: async () => "",
        } as unknown as Response;
      }

      submissionCount++;
      if (submissionCount <= 2) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ detail: "tx_bad_seq" }),
        } as unknown as Response;
      }

      return {
        ok: true,
        json: async () => ({ hash: `hash_${submissionCount}` }),
        text: async () => "",
      } as unknown as Response;
    });

    const client = makeClient();

    const submitterA = client.sendTransactionWithSequenceRecovery(
      "XDR_A",
      ACCOUNT_ID,
      async (seq) => `REBUILT_A_${seq}`,
      { useJitter: false, initialDelayMs: 0 },
    );

    const submitterB = client.sendTransactionWithSequenceRecovery(
      "XDR_B",
      ACCOUNT_ID,
      async (seq) => `REBUILT_B_${seq}`,
      { useJitter: false, initialDelayMs: 0 },
    );

    const [resultA, resultB] = await Promise.all([submitterA, submitterB]);

    expect(resultA.hash).toBeDefined();
    expect(resultB.hash).toBeDefined();
  });

  it("handles all submitters exhausting retries", async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input.toString();

      if (urlStr.includes("/accounts/")) {
        return {
          ok: true,
          json: async () => ({ id: ACCOUNT_ID, sequence: "1" }),
          text: async () => "",
        } as unknown as Response;
      }

      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ detail: "tx_bad_seq" }),
      } as unknown as Response;
    });

    const client = makeClient();

    const submitterA = client.sendTransactionWithSequenceRecovery(
      "XDR_A",
      ACCOUNT_ID,
      async (seq) => `REBUILT_A_${seq}`,
      { maxRetries: 1, useJitter: false, initialDelayMs: 0 },
    );

    const submitterB = client.sendTransactionWithSequenceRecovery(
      "XDR_B",
      ACCOUNT_ID,
      async (seq) => `REBUILT_B_${seq}`,
      { maxRetries: 1, useJitter: false, initialDelayMs: 0 },
    );

    const results = await Promise.allSettled([submitterA, submitterB]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");

    if (results[0].status === "rejected") {
      expect(results[0].reason).toBeInstanceOf(ContractSequenceCollisionError);
    }
    if (results[1].status === "rejected") {
      expect(results[1].reason).toBeInstanceOf(ContractSequenceCollisionError);
    }
  });

  it("proves convergence within bounded retries", async () => {
    const FAIL_COUNT = 4;

    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input.toString();

      if (urlStr.includes("/accounts/")) {
        return {
          ok: true,
          json: async () => ({ id: ACCOUNT_ID, sequence: "100" }),
          text: async () => "",
        } as unknown as Response;
      }

      const body = (init?.body as string) || "";
      const match = body.match(/XDR_(\d+)/);
      const retryNum = match ? parseInt(match[1], 10) : 0;

      if (retryNum < FAIL_COUNT) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ detail: "tx_bad_seq" }),
        } as unknown as Response;
      }

      return {
        ok: true,
        json: async () => ({ hash: "final_hash" }),
        text: async () => "",
      } as unknown as Response;
    });

    const client = makeClient();

    let retryNum = 0;
    const result = await client.sendTransactionWithSequenceRecovery(
      "XDR_0",
      ACCOUNT_ID,
      async () => {
        retryNum++;
        return `XDR_${retryNum}`;
      },
      { maxRetries: FAIL_COUNT, useJitter: false, initialDelayMs: 0 },
    );

    expect(result.hash).toBe("final_hash");
    expect(retryNum).toBeLessThanOrEqual(FAIL_COUNT);
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles sequence rollover during recovery", async () => {
    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "100" });

    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "101" });

    mockOk({ hash: TX_HASH });

    const sequences: string[] = [];
    const client = makeClient();

    const result = await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async (seq) => {
        sequences.push(seq);
        return `XDR_${seq}`;
      },
      { maxRetries: 3, useJitter: false, initialDelayMs: 0 },
    );

    expect(result.hash).toBe(TX_HASH);
    expect(sequences).toEqual(["100", "101"]);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("handles account not found during sequence re-read", async () => {
    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockJsonRpcError(404, "not found");

    const client = makeClient();
    await expect(
      client.sendTransactionWithSequenceRecovery(
        XDR,
        ACCOUNT_ID,
        async () => "REBUILT_XDR",
        { useJitter: false, initialDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ContractInvalidRequestError);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("calls onRetry callback with correct attempt numbers", async () => {
    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "1" });

    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "2" });

    mockOk({ hash: TX_HASH });

    const onRetryLog: { attempt: number; sequence: string }[] = [];
    const client = makeClient();

    await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async (seq) => `XDR_${seq}`,
      {
        maxRetries: 3,
        useJitter: false,
        initialDelayMs: 0,
        onRetry: (attempt, seq) => {
          onRetryLog.push({ attempt, sequence: seq });
        },
      },
    );

    expect(onRetryLog).toEqual([
      { attempt: 1, sequence: "1" },
      { attempt: 2, sequence: "2" },
    ]);
  });

  it("uses default options when none provided", async () => {
    mockOk({ hash: TX_HASH });

    const client = makeClient();
    const result = await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async () => XDR,
    );

    expect(result.hash).toBe(TX_HASH);
  });

  it("propagates error when rebuildXdr callback throws during recovery", async () => {
    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "42" });

    const client = makeClient();
    const rebuildError = new Error("signing failure during XDR rebuild");

    await expect(
      client.sendTransactionWithSequenceRecovery(
        XDR,
        ACCOUNT_ID,
        async () => { throw rebuildError; },
        { useJitter: false, initialDelayMs: 0 },
      ),
    ).rejects.toThrow("signing failure during XDR rebuild");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("propagates network error during getAccountSequence in recovery", async () => {
    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

    const client = makeClient();
    await expect(
      client.sendTransactionWithSequenceRecovery(
        XDR,
        ACCOUNT_ID,
        async () => "REBUILT_XDR",
        { useJitter: false, initialDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ContractProviderUnavailableError);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("fails immediately with maxRetries:0 on first collision", async () => {
    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));

    const client = makeClient();
    await expect(
      client.sendTransactionWithSequenceRecovery(
        XDR,
        ACCOUNT_ID,
        async () => { throw new Error("should not rebuild"); },
        { maxRetries: 0, useJitter: false, initialDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ContractSequenceCollisionError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat network errors as sequence collisions during submission", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const client = makeClient();
    await expect(
      client.sendTransactionWithSequenceRecovery(
        XDR,
        ACCOUNT_ID,
        async () => { throw new Error("should not be called"); },
        { useJitter: false, initialDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(ContractProviderUnavailableError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("selects non-jittered delay when useJitter is false", async () => {
    const delays: number[] = [];

    const origSetTimeout = global.setTimeout.bind(global);
    // @ts-expect-error - Spy replaces setTimeout
    const spy = jest.spyOn(global, "setTimeout").mockImplementation((fn: any, delay?: number, ...args: any[]) => {
      if (delay !== undefined && delay > 0 && delay < 5000) {
        delays.push(delay);
      }
      if (delay !== undefined && delay >= 5000) {
        return origSetTimeout(fn, 1, ...args);
      }
      if (typeof fn === "function") {
        fn(...args);
      }
      return 1 as unknown as NodeJS.Timeout;
    });

    mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
    mockOk({ id: ACCOUNT_ID, sequence: "1" });
    mockOk({ hash: TX_HASH });

    const client = makeClient();
    await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async (seq) => `XDR_${seq}`,
      { maxRetries: 3, useJitter: false, initialDelayMs: 50 },
    );

    expect(delays.length).toBe(1);
    expect(delays[0]).toBe(50);

    spy.mockRestore();
  });

  it("onRetry callback is not invoked when submission succeeds first try", async () => {
    mockOk({ hash: TX_HASH });

    let onRetryCalled = false;
    const client = makeClient();

    await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async () => XDR,
      {
        onRetry: () => { onRetryCalled = true; },
      },
    );

    expect(onRetryCalled).toBe(false);
  });

  it("can recover after many consecutive collisions with maxRetries:5", async () => {
    const COLLISIONS = 5;
    for (let i = 0; i < COLLISIONS; i++) {
      mockJsonRpcError(400, JSON.stringify({ detail: "tx_bad_seq" }));
      mockOk({ id: ACCOUNT_ID, sequence: String(i + 10) });
    }
    mockOk({ hash: TX_HASH });

    const client = makeClient();
    let rebuildCount = 0;

    const result = await client.sendTransactionWithSequenceRecovery(
      XDR,
      ACCOUNT_ID,
      async (seq) => {
        rebuildCount++;
        return `XDR_${seq}`;
      },
      { maxRetries: 5, useJitter: false, initialDelayMs: 0 },
    );

    expect(result.hash).toBe(TX_HASH);
    expect(rebuildCount).toBe(COLLISIONS);
  });
});

// ─── Should retry contract error ──────────────────────────────────────────────

describe("shouldRetryContractError with sequence collisions", () => {
  it("tx_bad_seq is considered retryable by ContractService", async () => {
    jest.useFakeTimers();

    const service = new ContractService(
      new RetryPolicy({
        maxRetries: 2,
        initialDelay: 10,
        backoffFactor: 1,
        maxDelay: 10,
        useJitter: false,
      }),
    );

    let callCount = 0;
    const action = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("tx_bad_seq");
      }
      return "success";
    };

    const promise = service.call("test", action);
    await jest.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result).toBe("success");
    expect(callCount).toBe(2);

    jest.useRealTimers();
  });

  it("bad sequence error is considered retryable by ContractService", async () => {
    jest.useFakeTimers();

    const service = new ContractService(
      new RetryPolicy({
        maxRetries: 2,
        initialDelay: 10,
        backoffFactor: 1,
        maxDelay: 10,
        useJitter: false,
      }),
    );

    let callCount = 0;
    const action = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("bad sequence number");
      }
      return "success";
    };

    const promise = service.call("test", action);
    await jest.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result).toBe("success");
    expect(callCount).toBe(2);

    jest.useRealTimers();
  });
});
