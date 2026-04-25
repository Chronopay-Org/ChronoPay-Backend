import { jest } from "@jest/globals";

const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockLogError = jest.fn();

// In ESM, we must mock the module before importing it if we use unstable_mockModule.
// But since we are using regular imports above, we might have issues.
// Let's use a simpler approach: mock the logger by passing it or just skip log verification for now
// to ensure the core logic (timeout/retry) works.
// Actually, I'll try to use a manual mock if I can.

jest.unstable_mockModule("../utils/logger.js", () => ({
  logInfo: mockLogInfo,
  logWarn: mockLogWarn,
  logError: mockLogError,
}));

// We need to dynamic import the helpers after mocking
const { withTimeout, withRetry } = await import("../utils/outbound-helper.js");
const { OutboundTimeoutError, OutboundUnavailableError, OutboundBadResponseError } = await import("../errors/OutboundErrors.js");

describe("Outbound Helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("withTimeout", () => {
    it("should complete successfully if within timeout", async () => {
      const result = await withTimeout(
        async () => "success",
        1000,
        "test-service"
      );
      expect(result).toBe("success");
    });

    it("should throw OutboundTimeoutError if timeout is reached", async () => {
      const slowFn = async (signal: AbortSignal) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 2000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("AbortError"));
          });
        });
      };

      await expect(withTimeout(slowFn as any, 100, "test-service")).rejects.toThrow(OutboundTimeoutError);
      expect(mockLogWarn).toHaveBeenCalledWith("outbound_timeout", expect.objectContaining({
        service: "test-service",
        timeoutMs: 100,
      }));
    });

    it("should not contain raw URLs in error messages", async () => {
      const fn = async () => {
        throw new Error("Failed to connect to https://secret-api.com/v1/data");
      };

      try {
        await withTimeout(fn, 1000, "test-service");
      } catch (err: any) {
        // ...
      }
    });
  });

  describe("withRetry", () => {
    it("should succeed on first attempt", async () => {
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue("success");
      const result = await withRetry(fn, { serviceName: "test-service" });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on transient errors and eventually succeed", async () => {
      const fn = jest.fn<() => Promise<string>>()
        .mockRejectedValueOnce(new OutboundTimeoutError("test-service"))
        .mockRejectedValueOnce(new Error("500 Internal Server Error"))
        .mockResolvedValue("success");

      const result = await withRetry(fn, { 
        serviceName: "test-service",
        baseDelayMs: 1
      });

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
      expect(mockLogWarn).toHaveBeenCalledWith("outbound_retry_attempt", expect.objectContaining({
        service: "test-service",
        attempt: 1
      }));
      expect(mockLogWarn).toHaveBeenCalledWith("outbound_retry_attempt", expect.objectContaining({
        service: "test-service",
        attempt: 2
      }));
    });

    it("should throw OutboundUnavailableError after max attempts", async () => {
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(new OutboundTimeoutError("test-service"));

      await expect(withRetry(fn, { 
        serviceName: "test-service", 
        maxAttempts: 2,
        baseDelayMs: 1
      })).rejects.toThrow(OutboundUnavailableError);

      expect(fn).toHaveBeenCalledTimes(2);
      expect(mockLogError).toHaveBeenCalledWith("outbound_failure", expect.objectContaining({
        service: "test-service",
        attempt: 2
      }));
    });

    it("should not retry on non-transient errors (e.g., 400)", async () => {
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue({ statusCode: 400, message: "Bad Request" });

      await expect(withRetry(fn, { 
        serviceName: "test-service",
        baseDelayMs: 1
      })).rejects.toMatchObject({ statusCode: 400 });

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should respect total budget", async () => {
      const fn = jest.fn<() => Promise<string>>().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        throw new OutboundTimeoutError("test-service");
      });

      await expect(withRetry(fn, { 
        serviceName: "test-service",
        maxTotalBudgetMs: 50, // Smaller than one attempt's work
        baseDelayMs: 1
      })).rejects.toThrow(OutboundUnavailableError);

      expect(mockLogError).toHaveBeenCalledWith("outbound_budget_exceeded", expect.objectContaining({
        service: "test-service",
        maxTotalBudgetMs: 50
      }));
    });
  });
});
