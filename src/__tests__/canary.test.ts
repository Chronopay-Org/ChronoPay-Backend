import { jest } from "@jest/globals";
import { runCanary, canarySuccessCounter, canaryFailureCounter } from "../../scripts/canary.js";
import { setRedisClient } from "../cache/redisClient.js";

// Mock the redis client
const mockRedisClient = {
  set: jest.fn().mockResolvedValue("OK"),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(1),
  keys: jest.fn().mockResolvedValue([]),
  ping: jest.fn().mockResolvedValue("PONG"),
  quit: jest.fn().mockResolvedValue("OK"),
};

describe("Canary probe", () => {
  let fetchSpy: any;

  beforeEach(() => {
    // Reset metrics before each test
    canarySuccessCounter.reset();
    canaryFailureCounter.reset();

    setRedisClient(mockRedisClient as any);
    jest.clearAllMocks();

    fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = input.toString();
      if (url.includes("/booking-intents") && init?.method === "POST") {
        if (url.endsWith("/confirm") || url.endsWith("/cancel")) {
          return { ok: true, status: 200 } as Response;
        }
        // Create intent response
        return {
          ok: true,
          status: 201,
          json: async () => ({ intent: { id: "intent-123" } }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setRedisClient(null);
  });

  it("should successfully execute full booking flow", async () => {
    mockRedisClient.get.mockResolvedValueOnce(null); // No stale intent
    mockRedisClient.set.mockResolvedValueOnce("OK"); // Lock acquired
    mockRedisClient.set.mockResolvedValueOnce("OK"); // Stale artifact marker set

    await runCanary();

    expect(fetchSpy).toHaveBeenCalledTimes(3); // create, confirm, cancel
    expect((await canarySuccessCounter.get()).values[0].value).toBe(1);
    expect((await canaryFailureCounter.get()).values[0].value).toBe(0);
    
    // Lock should be deleted
    expect(mockRedisClient.del).toHaveBeenCalledWith("canary:tenant_lock");
    // Stale marker should be deleted after success
    expect(mockRedisClient.del).toHaveBeenCalledWith("canary:stale_intent");
  });

  it("should clean up stale artifact before running", async () => {
    mockRedisClient.get.mockResolvedValueOnce("stale-intent-456"); // Stale intent found
    mockRedisClient.set.mockResolvedValueOnce("OK"); // Lock acquired
    mockRedisClient.set.mockResolvedValueOnce("OK"); // Stale artifact marker set for new intent

    await runCanary();

    expect(fetchSpy).toHaveBeenCalledTimes(4); // cancel stale, then create, confirm, cancel new
    const firstFetch = fetchSpy.mock.calls[0];
    expect(firstFetch[0]).toContain("/booking-intents/stale-intent-456/cancel");

    expect(mockRedisClient.del).toHaveBeenCalledWith("canary:stale_intent"); // Deleted after cleanup
  });

  it("should skip execution if tenant lock is held", async () => {
    mockRedisClient.set.mockResolvedValueOnce(null); // Lock not acquired (already locked)
    
    await runCanary();

    expect(fetchSpy).not.toHaveBeenCalled();
    // Metrics should not be incremented
    expect((await canarySuccessCounter.get()).values[0].value).toBe(0);
    expect((await canaryFailureCounter.get()).values[0].value).toBe(0);
  });

  it("should increment failure counter and clear lock on error", async () => {
    mockRedisClient.get.mockResolvedValueOnce(null); // No stale intent
    mockRedisClient.set.mockResolvedValueOnce("OK"); // Lock acquired
    
    // Make create intent fail
    fetchSpy.mockImplementationOnce(async () => {
      return { ok: false, status: 500 } as Response;
    });

    await runCanary();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await canarySuccessCounter.get()).values[0].value).toBe(0);
    expect((await canaryFailureCounter.get()).values[0].value).toBe(1);
    
    // Lock should still be cleared
    expect(mockRedisClient.del).toHaveBeenCalledWith("canary:tenant_lock");
  });

  it("should fail and increment failure counter if confirm intent fails", async () => {
    mockRedisClient.get.mockResolvedValueOnce(null);
    mockRedisClient.set.mockResolvedValueOnce("OK");
    
    fetchSpy.mockImplementationOnce(async (_input: RequestInfo) => {
      // create works
      return { ok: true, status: 201, json: async () => ({ intent: { id: "intent-123" } }) } as Response;
    }).mockImplementationOnce(async () => {
      // confirm fails
      return { ok: false, status: 500 } as Response;
    });

    await runCanary();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((await canarySuccessCounter.get()).values[0].value).toBe(0);
    expect((await canaryFailureCounter.get()).values[0].value).toBe(1);
  });

  it("should fail and increment failure counter if cancel intent fails", async () => {
    mockRedisClient.get.mockResolvedValueOnce(null);
    mockRedisClient.set.mockResolvedValueOnce("OK");
    
    fetchSpy.mockImplementationOnce(async (_input: RequestInfo) => {
      // create works
      return { ok: true, status: 201, json: async () => ({ intent: { id: "intent-123" } }) } as Response;
    }).mockImplementationOnce(async () => {
      // confirm works
      return { ok: true, status: 200 } as Response;
    }).mockImplementationOnce(async () => {
      // cancel fails
      return { ok: false, status: 500 } as Response;
    });

    await runCanary();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect((await canarySuccessCounter.get()).values[0].value).toBe(0);
    expect((await canaryFailureCounter.get()).values[0].value).toBe(1);
  });

  it("should handle running when redis is not configured (returns null)", async () => {
    setRedisClient(null);

    await runCanary();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect((await canarySuccessCounter.get()).values[0].value).toBe(1);
    expect((await canaryFailureCounter.get()).values[0].value).toBe(0);
  });
});
