import { jest } from "@jest/globals";

// ─── Stubs ────────────────────────────────────────────────────────────────────
// Track metric calls without hitting the real Prometheus registry.
const _rlCalls: Array<[string, number]> = [];
const _qdCalls: Array<[string, number]> = [];

jest.unstable_mockModule("../../metrics/horizonMetrics.js", () => ({
  recordRateLimitRemaining: (host: string, remaining: number) => {
    _rlCalls.push([host, remaining]);
  },
  recordQueueDepth: (host: string, depth: number) => {
    _qdCalls.push([host, depth]);
  },
  resetHorizonMetricsForHost: jest.fn(),
  horizonRateLimitRemaining: {},
  horizonRequestQueueDepth: {},
}));

// Dynamically import AFTER mocking
const {
  HorizonTokenBucket,
  HorizonContractClient,
  HorizonHttpError,
  getTokenBucketForHost,
  _setTokenBucketForHost,
  _clearTokenBuckets,
} = await import("../../clients/horizon-contract-client.js");

const { ContractService } = await import("../../services/contract.service.js");
const { RetryPolicy } = await import("../../utils/retry-policy.js");
const { ContractRateLimitError } = await import("../../errors/contractErrors.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const HOST = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const ACCOUNT_ID = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

function makeService() {
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

function makeClient(url = HOST, opts = {}) {
  return new HorizonContractClient(url, PASSPHRASE, makeService(), opts);
}

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockOkWithHeaders(body: unknown, headers: Record<string, string> = {}) {
  // @ts-expect-error - jest mock
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

function mockOk(body: unknown) {
  mockOkWithHeaders(body, {});
}

function mockHttpError(status: number, body = "", headers: Record<string, string> = {}) {
  // @ts-expect-error - jest mock
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    text: async () => body,
  } as unknown as Response);
}

beforeEach(() => {
  mockFetch.mockReset();
  _clearTokenBuckets();
  _rlCalls.length = 0;
  _qdCalls.length = 0;
});

// ─── HorizonTokenBucket unit tests ───────────────────────────────────────────

describe("HorizonTokenBucket", () => {
  describe("initial state", () => {
    it("starts with the supplied initialCapacity", () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 5 });
      expect(bucket.tokens).toBe(5);
    });

    it("defaults to initialCapacity of 10 when not specified", () => {
      const bucket = new HorizonTokenBucket(HOST);
      expect(bucket.tokens).toBe(10);
    });

    it("starts with an empty queue", () => {
      const bucket = new HorizonTokenBucket(HOST);
      expect(bucket.queueDepth).toBe(0);
    });
  });

  describe("acquire — fast path", () => {
    it("decrements tokens on acquire when tokens > 0", async () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 3 });
      await bucket.acquire();
      expect(bucket.tokens).toBe(2);
    });

    it("acquires without throwing when tokens = -1 (unknown)", async () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: -1 });
      await expect(bucket.acquire()).resolves.not.toThrow();
    });

    it("does not queue when tokens are available", async () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 5 });
      await bucket.acquire();
      expect(bucket.queueDepth).toBe(0);
    });

    it("allows as many acquires as the initial capacity", async () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 3 });
      await bucket.acquire();
      await bucket.acquire();
      await bucket.acquire();
      expect(bucket.tokens).toBe(0);
    });
  });

  describe("acquire — queue path (bucket empty)", () => {
    it("queues a request when tokens = 0", async () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 0 });
      // Do not await — this should be pending
      const pending = bucket.acquire();
      expect(bucket.queueDepth).toBe(1);
      // Drain by update
      bucket.update(5, 0);
      await pending;
      expect(bucket.queueDepth).toBe(0);
    });

    it("throws ContractRateLimitError synchronously when the queue is full", async () => {
      const bucket = new HorizonTokenBucket(HOST, {
        initialCapacity: 0,
        maxQueueDepth: 0,
      });
      // maxQueueDepth=0 means the very first queued request is rejected
      await expect(bucket.acquire()).rejects.toBeInstanceOf(ContractRateLimitError);
    });

    it("throws after filling queue to capacity", async () => {
      const bucket = new HorizonTokenBucket(HOST, {
        initialCapacity: 0,
        maxQueueDepth: 2,
      });
      // Two pending acquires fill the queue
      const p1 = bucket.acquire();
      const p2 = bucket.acquire();
      // Third should throw immediately
      await expect(bucket.acquire()).rejects.toBeInstanceOf(ContractRateLimitError);
      // Drain so the test ends cleanly
      bucket.update(10, 0);
      await Promise.all([p1, p2]);
    });

    it("reports queue depth as 0 after the queue is drained", async () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 0 });
      const p1 = bucket.acquire();
      const p2 = bucket.acquire();
      expect(bucket.queueDepth).toBe(2);
      bucket.update(10, 0);
      await Promise.all([p1, p2]);
      expect(bucket.queueDepth).toBe(0);
    });

    it("releases queued requests in FIFO order", async () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 0 });
      const order: number[] = [];
      const p1 = bucket.acquire().then(() => order.push(1));
      const p2 = bucket.acquire().then(() => order.push(2));
      const p3 = bucket.acquire().then(() => order.push(3));
      bucket.update(3, 0);
      await Promise.all([p1, p2, p3]);
      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("update", () => {
    it("updates remaining tokens from a header value", () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 5 });
      bucket.update(99, 0);
      expect(bucket.tokens).toBe(99);
    });

    it("ignores a NaN remaining value", () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 5 });
      bucket.update(NaN, 0);
      expect(bucket.tokens).toBe(5);
    });

    it("ignores a negative remaining value", () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 5 });
      bucket.update(-1, 0);
      expect(bucket.tokens).toBe(5);
    });

    it("drains queued requests when remaining becomes positive after update", async () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 0 });
      const p = bucket.acquire();
      bucket.update(5, 0);
      await p;
      expect(bucket.queueDepth).toBe(0);
    });

    it("records remaining metric when update is called with valid value", () => {
      _rlCalls.length = 0;
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 0 });
      bucket.update(42, 0);
      const found = _rlCalls.find(([h, v]) => h === HOST && v === 42);
      expect(found).toBeDefined();
    });

    it("records queue depth metric when update is called", () => {
      _qdCalls.length = 0;
      const bucket = new HorizonTokenBucket(HOST);
      bucket.update(5, 0);
      const found = _qdCalls.find(([h, v]) => h === HOST && v === 0);
      expect(found).toBeDefined();
    });
  });

  describe("reset via window expiry", () => {
    it("passes through immediately when reset epoch is in the past", async () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 0 });
      // Set a past reset epoch (1 second ago)
      bucket.update(0, Math.floor((Date.now() - 1_000) / 1_000));
      await expect(bucket.acquire()).resolves.not.toThrow();
    });
  });

  describe("backoff", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("waits for the supplied retryAfterMs before draining", async () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 0 });
      const p = bucket.acquire();

      const backoffPromise = bucket.backoff(500);
      jest.advanceTimersByTime(500);
      await backoffPromise;
      await p;
      expect(bucket.queueDepth).toBe(0);
    });

    it("falls back to 1000 ms when no hint is provided and resetAt is 0", async () => {
      const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 0 });
      const backoffPromise = bucket.backoff();
      jest.advanceTimersByTime(1_000);
      await backoffPromise;
      expect(bucket.tokens).toBe(-1);
    });
  });
});

// ─── Token-bucket registry ────────────────────────────────────────────────────

describe("getTokenBucketForHost", () => {
  it("creates a new bucket on first call", () => {
    const bucket = getTokenBucketForHost(HOST);
    expect(bucket).toBeInstanceOf(HorizonTokenBucket);
  });

  it("returns the same instance on subsequent calls", () => {
    const b1 = getTokenBucketForHost(HOST);
    const b2 = getTokenBucketForHost(HOST);
    expect(b1).toBe(b2);
  });

  it("creates distinct instances for different hosts", () => {
    const b1 = getTokenBucketForHost("https://host-a.stellar.org");
    const b2 = getTokenBucketForHost("https://host-b.stellar.org");
    expect(b1).not.toBe(b2);
  });

  it("_setTokenBucketForHost replaces the bucket for a host", () => {
    const original = getTokenBucketForHost(HOST);
    const replacement = new HorizonTokenBucket(HOST, { initialCapacity: 99 });
    _setTokenBucketForHost(HOST, replacement);
    expect(getTokenBucketForHost(HOST)).toBe(replacement);
    expect(getTokenBucketForHost(HOST)).not.toBe(original);
  });

  it("_clearTokenBuckets removes all registered buckets", () => {
    getTokenBucketForHost(HOST);
    _clearTokenBuckets();
    const fresh = getTokenBucketForHost(HOST);
    expect(fresh.tokens).toBe(10); // default initialCapacity
  });
});

// ─── HorizonContractClient token-bucket integration ──────────────────────────

describe("HorizonContractClient — token-bucket integration", () => {
  it("records remaining metric from X-RateLimit-Remaining header", async () => {
    _rlCalls.length = 0;
    const client = makeClient();
    mockOkWithHeaders({ id: ACCOUNT_ID, sequence: "1" }, {
      "X-RateLimit-Remaining": "97",
      "X-RateLimit-Reset": "9999999999",
    });

    await client.call({ address: ACCOUNT_ID, abi: null, method: "getAccount", args: [ACCOUNT_ID] });
    // The bucket calls recordRateLimitRemaining(host, 97) after the response
    const recorded = _rlCalls.find(([, v]) => v === 97);
    expect(recorded).toBeDefined();
  });

  it("works correctly when rate-limit headers are absent", async () => {
    const client = makeClient();
    mockOk({ id: ACCOUNT_ID, sequence: "1" });

    await expect(
      client.call({ address: ACCOUNT_ID, abi: null, method: "getAccount", args: [ACCOUNT_ID] }),
    ).resolves.not.toThrow();
  });

  it("throws on 429 response (ContractRateLimitError via ContractService)", async () => {
    const client = makeClient();
    mockHttpError(429, "too many requests");

    await expect(
      client.call({ address: ACCOUNT_ID, abi: null, method: "getAccount", args: [ACCOUNT_ID] }),
    ).rejects.toThrow();
  });

  it("throws ContractRateLimitError when the queue is full (maxQueueDepth=0)", async () => {
    // Inject a bucket that has 0 tokens and 0 maxQueueDepth so any acquire throws
    const fullBucket = new HorizonTokenBucket(HOST, {
      initialCapacity: 0,
      maxQueueDepth: 0,
    });
    _setTokenBucketForHost(HOST, fullBucket);

    const client = makeClient(HOST);
    await expect(
      client.call({ address: ACCOUNT_ID, abi: null, method: "getAccount", args: [ACCOUNT_ID] }),
    ).rejects.toBeInstanceOf(ContractRateLimitError);
  });

  it("queues and releases a request when bucket is unknown (tokens=-1)", async () => {
    const bucket = new HorizonTokenBucket(HOST, { initialCapacity: -1 });
    _setTokenBucketForHost(HOST, bucket);

    const client = makeClient(HOST);
    mockOk({ id: ACCOUNT_ID, sequence: "1" });

    await expect(
      client.call({ address: ACCOUNT_ID, abi: null, method: "getAccount", args: [ACCOUNT_ID] }),
    ).resolves.not.toThrow();
  });

  it("reuses the same bucket across multiple calls for the same host", async () => {
    const client = makeClient(HOST, { initialCapacity: 100 });
    mockOk({ id: ACCOUNT_ID, sequence: "1" });
    mockOk({ id: ACCOUNT_ID, sequence: "2" });

    await client.call({ address: ACCOUNT_ID, abi: null, method: "getAccount", args: [ACCOUNT_ID] });
    await client.call({ address: ACCOUNT_ID, abi: null, method: "getAccount", args: [ACCOUNT_ID] });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("accepts TokenBucketOptions in the constructor without throwing", () => {
    expect(() => makeClient(HOST, {
      initialCapacity: 50,
      maxQueueDepth: 100,
      rateLimitRetryConfig: { maxRetries429: 3 },
    })).not.toThrow();
  });
});

// ─── Concurrency: burst of requests with limited tokens ──────────────────────

describe("HorizonTokenBucket concurrency — burst scenario", () => {
  it("only executes N requests immediately when bucket has N tokens, queuing the rest", async () => {
    const N = 5;
    const bucket = new HorizonTokenBucket(HOST, { initialCapacity: N, maxQueueDepth: 20 });

    const executed: number[] = [];
    const acquires = Array.from({ length: N + 3 }, (_, i) =>
      bucket.acquire().then(() => executed.push(i)),
    );

    // Allow microtasks to flush
    await Promise.resolve();
    // N of the acquires should have completed immediately
    expect(executed.length).toBe(N);
    expect(bucket.queueDepth).toBe(3);

    // Refill with 3 more tokens
    bucket.update(3, 0);
    await Promise.all(acquires);
    expect(executed.length).toBe(N + 3);
    expect(bucket.queueDepth).toBe(0);
  });

  it("handles 200 concurrent acquire calls gracefully when 10 tokens are available", async () => {
    const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 10, maxQueueDepth: 250 });

    const acquires = Array.from({ length: 200 }, () => bucket.acquire());

    await Promise.resolve();
    expect(bucket.queueDepth).toBe(190);

    bucket.update(190, 0);
    await Promise.all(acquires);
    expect(bucket.queueDepth).toBe(0);
  });

  it("rejects exactly the overflow acquires beyond maxQueueDepth", async () => {
    const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 0, maxQueueDepth: 5 });

    const results: Array<"ok" | ContractRateLimitError> = [];

    // Start 8 acquires; 5 should queue, 3 should reject immediately
    const promises = Array.from({ length: 8 }, () =>
      bucket
        .acquire()
        .then(() => results.push("ok" as const))
        .catch((e: unknown) => results.push(e as ContractRateLimitError)),
    );

    // All rejections are synchronous (no timer needed)
    await Promise.resolve();
    await Promise.resolve();

    const errors = results.filter((r) => r instanceof ContractRateLimitError);
    expect(errors.length).toBe(3);
    expect(bucket.queueDepth).toBe(5);

    // Clean up: drain the queued requests
    bucket.update(10, 0);
    await Promise.all(promises);
  });
});

// ─── Boundary inputs ─────────────────────────────────────────────────────────

describe("HorizonTokenBucket boundary inputs", () => {
  it("handles initialCapacity = 0 without throwing", () => {
    expect(() => new HorizonTokenBucket(HOST, { initialCapacity: 0 })).not.toThrow();
  });

  it("handles initialCapacity = Number.MAX_SAFE_INTEGER", async () => {
    const bucket = new HorizonTokenBucket(HOST, {
      initialCapacity: Number.MAX_SAFE_INTEGER,
    });
    await expect(bucket.acquire()).resolves.not.toThrow();
  });

  it("ignores a zero resetEpoch in update without throwing", () => {
    const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 5 });
    expect(() => bucket.update(5, 0)).not.toThrow();
  });

  it("handles update with remaining=0 and future resetEpoch correctly", async () => {
    const bucket = new HorizonTokenBucket(HOST, { initialCapacity: 1 });
    await bucket.acquire(); // tokens now 0
    const futureEpoch = Math.floor((Date.now() + 60_000) / 1_000);
    bucket.update(0, futureEpoch);
    // Queue depth should still be 0 (no queued requests)
    expect(bucket.queueDepth).toBe(0);
  });
});

// ─── HorizonHttpError backward-compatibility ──────────────────────────────────

describe("HorizonHttpError backward-compatibility", () => {
  it("429 message still contains 'rate limit'", () => {
    expect(new HorizonHttpError(429, "err").message).toContain("rate limit");
  });

  it("5xx message still contains 'service unavailable'", () => {
    expect(new HorizonHttpError(503, "err").message).toContain("service unavailable");
  });

  it("4xx message still contains 'invalid argument'", () => {
    expect(new HorizonHttpError(400, "err").message).toContain("invalid argument");
  });
});
