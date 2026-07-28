import { jest } from "@jest/globals";
import { HorizonContractClient, HorizonTransactionRecord, HorizonCollectionResponse } from "../horizon-contract-client.js";
import { ContractService } from "../../services/contract.service.js";
import { RetryPolicy } from "../../utils/retry-policy.js";

const BASE_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const ACCOUNT_ID = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

/**
 * In-memory Mock Horizon Endpoint simulating Stellar transaction storage
 * with configurable concurrent write bursts and rate-limit interstitials.
 */
class MockHorizonServer {
  private records: HorizonTransactionRecord[] = [];
  private currentId = 1000000000000000n;
  private rateLimitFrequency = 0; // 0 = disabled, >0 = fail every Nth request with 429
  private requestCount = 0;

  constructor() {
    this.records = [];
  }

  /**
   * Sets rate limit frequency to trigger HTTP 429 every N requests.
   */
  setRateLimitFrequency(freq: number) {
    this.rateLimitFrequency = freq;
  }

  /**
   * Injects N new transactions into the mock storage with monotonically increasing cursor tokens.
   */
  burstWrites(count: number): HorizonTransactionRecord[] {
    const created: HorizonTransactionRecord[] = [];
    for (let i = 0; i < count; i++) {
      this.currentId += 1n;
      const idStr = this.currentId.toString();
      const record: HorizonTransactionRecord = {
        id: idStr,
        paging_token: idStr,
        hash: `tx_hash_${idStr}`,
        ledger: Math.floor(Number(this.currentId) / 100),
        created_at: new Date().toISOString(),
      };
      this.records.push(record);
      created.push(record);
    }
    return created;
  }

  /**
   * Simulates GET /accounts/{accountId}/transactions?cursor=...&limit=...&order=...
   */
  handleFetch(urlStr: string): { status: number; body: HorizonCollectionResponse | string } {
    this.requestCount++;
    if (this.rateLimitFrequency > 0 && this.requestCount % this.rateLimitFrequency === 0) {
      return { status: 429, body: "rate limit exceeded" };
    }

    const url = new URL(urlStr);
    const cursor = url.searchParams.get("cursor");
    const limit = parseInt(url.searchParams.get("limit") || "200", 10);
    const order = url.searchParams.get("order") || "asc";

    let filtered = [...this.records];

    if (cursor) {
      const cursorBig = BigInt(cursor);
      if (order === "asc") {
        filtered = filtered.filter((r) => BigInt(r.paging_token) > cursorBig);
      } else {
        filtered = filtered.filter((r) => BigInt(r.paging_token) < cursorBig);
      }
    }

    if (order === "desc") {
      filtered.sort((a, b) => (BigInt(b.paging_token) > BigInt(a.paging_token) ? 1 : -1));
    } else {
      filtered.sort((a, b) => (BigInt(a.paging_token) > BigInt(b.paging_token) ? 1 : -1));
    }

    const pageRecords = filtered.slice(0, limit);

    return {
      status: 200,
      body: {
        _embedded: {
          records: pageRecords,
        },
      },
    };
  }

  get totalCount(): number {
    return this.records.length;
  }
}

describe("Horizon Cursor Drift Stress Tests", () => {
  let mockServer: MockHorizonServer;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockServer = new MockHorizonServer();
    originalFetch = global.fetch;

    // @ts-expect-error - Mocking fetch with custom router
    global.fetch = jest.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input.toString();
      const res = mockServer.handleFetch(urlStr);

      if (res.status !== 200) {
        return {
          ok: false,
          status: res.status,
          text: async () => res.body as string,
        } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => res.body,
        text: async () => JSON.stringify(res.body),
      } as unknown as Response;
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function createTestClient(): HorizonContractClient {
    const service = new ContractService(
      new RetryPolicy({ maxRetries: 0, initialDelay: 0, backoffFactor: 1, maxDelay: 0, useJitter: false }),
    );
    return new HorizonContractClient(BASE_URL, PASSPHRASE, service);
  }

  describe("Concurrent Write Burst & Monotonic Delivery (10k synthetic ops)", () => {
    it("proves 0 duplicates and 0 gaps across 10,000 synthetic operations with concurrent writes", async () => {
      const client = createTestClient();
      const TOTAL_OPS = 10000;
      const INITIAL_BURST = 1000;

      // Seed initial data
      mockServer.burstWrites(INITIAL_BURST);

      // Record initial memory pressure
      if (global.gc) global.gc();
      const initialMem = process.memoryUsage();

      // Launch background write bursts simulating continuous incoming transactions
      let remaining = TOTAL_OPS - INITIAL_BURST;
      const writeInterval = setInterval(() => {
        if (remaining > 0) {
          const chunkSize = Math.min(remaining, 500);
          mockServer.burstWrites(chunkSize);
          remaining -= chunkSize;
        } else {
          clearInterval(writeInterval);
        }
      }, 5);

      // Fetch all transactions using fetchAllTransactionsPaged
      const records = await client.fetchAllTransactionsPaged(ACCOUNT_ID, {
        limitPerPage: 200,
        order: "asc",
        maxRecords: TOTAL_OPS,
      });

      clearInterval(writeInterval);

      // Ensure write worker finishes inserting remainder if any
      if (remaining > 0) {
        mockServer.burstWrites(remaining);
        remaining = 0;
      }

      // If client stopped because maxRecords was hit or end of stream, fetch rest if any
      const finalRecords = await client.fetchAllTransactionsPaged(ACCOUNT_ID, {
        limitPerPage: 200,
        order: "asc",
        initialCursor: records.length > 0 ? records[records.length - 1].paging_token : undefined,
      });

      const allRecords = [...records, ...finalRecords];

      // Record final memory pressure
      const finalMem = process.memoryUsage();
      const heapDiffMB = (finalMem.heapUsed - initialMem.heapUsed) / (1024 * 1024);

      // Log memory metrics for verification evidence
      console.log(`[Memory Pressure Log] Initial Heap: ${(initialMem.heapUsed / (1024 * 1024)).toFixed(2)} MB | Final Heap: ${(finalMem.heapUsed / (1024 * 1024)).toFixed(2)} MB | Delta: ${heapDiffMB.toFixed(2)} MB`);

      // Assertion 1: Total records delivered matches total synthetic operations
      expect(allRecords.length).toBe(TOTAL_OPS);

      // Assertion 2: Strict Monotonic Cursor Delivery & No Duplicates
      const seenTokens = new Set<string>();
      let previousToken = 0n;

      for (let i = 0; i < allRecords.length; i++) {
        const tokenStr = allRecords[i].paging_token;
        const currentToken = BigInt(tokenStr);

        // Check for duplicates
        expect(seenTokens.has(tokenStr)).toBe(false);
        seenTokens.add(tokenStr);

        // Check strict monotonic order (no cursor drift or gaps)
        if (i > 0) {
          expect(currentToken).toBeGreaterThan(previousToken);
          // Gaps check: verify contiguous sequential incrementation
          expect(currentToken - previousToken).toBe(1n);
        }

        previousToken = currentToken;
      }

      // Assertion 3: Set size proves 0 duplicates
      expect(seenTokens.size).toBe(TOTAL_OPS);

      // Assertion 4: Memory growth is bounded (< 50MB for 10k items)
      expect(heapDiffMB).toBeLessThan(50);
    });
  });

  describe("Pagination Edge Cases", () => {
    it("handles an empty cursor page gracefully when fetching beyond available records", async () => {
      mockServer.burstWrites(10);
      const client = createTestClient();

      // Fetch page beyond current records
      const res = await client.getTransactionsPaged(ACCOUNT_ID, {
        cursor: "9999999999999999",
        limit: 10,
      });

      expect(res.data._embedded.records).toHaveLength(0);

      // fetchAllTransactionsPaged should return empty array when initial cursor is beyond data
      const records = await client.fetchAllTransactionsPaged(ACCOUNT_ID, {
        initialCursor: "9999999999999999",
      });
      expect(records).toHaveLength(0);
    });

    it("handles single-record pages (limit = 1) cleanly without drift", async () => {
      mockServer.burstWrites(5);
      const client = createTestClient();

      const records = await client.fetchAllTransactionsPaged(ACCOUNT_ID, {
        limitPerPage: 1,
      });

      expect(records).toHaveLength(5);
      expect(records.map((r) => r.id)).toEqual(
        records.map((_, i) => (1000000000000001n + BigInt(i)).toString()),
      );
    });

    it("recovers seamlessly from rate-limit interstitials (HTTP 429) without dropping records", async () => {
      mockServer.burstWrites(20);
      mockServer.setRateLimitFrequency(3); // Fail every 3rd request with HTTP 429
      const client = createTestClient();

      let rateLimitInterstitialsHandled = 0;

      const records = await client.fetchAllTransactionsPaged(ACCOUNT_ID, {
        limitPerPage: 5,
        maxRetriesOnRateLimit: 5,
        onRateLimit: async () => {
          rateLimitInterstitialsHandled++;
        },
      });

      expect(rateLimitInterstitialsHandled).toBeGreaterThan(0);
      expect(records).toHaveLength(20);

      // Verify no duplicates and no missing items despite 429 errors
      const ids = records.map((r) => r.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(20);
    });
  });
});
