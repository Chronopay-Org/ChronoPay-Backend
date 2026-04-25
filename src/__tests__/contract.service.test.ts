import { jest } from "@jest/globals";
import { ContractService } from "../services/contract.service.js";
import { RetryPolicy } from "../utils/retry-policy.js";

describe("ContractService", () => {
  let service: ContractService;
  let mockRetryPolicy: any;

  beforeEach(() => {
    mockRetryPolicy = {
      execute: jest.fn(),
    };
    service = new ContractService(mockRetryPolicy as RetryPolicy);
  });

  it("should call the retry policy's execute method", async () => {
    const action = jest.fn<() => Promise<string>>().mockResolvedValue("success");
    mockRetryPolicy.execute.mockImplementation(async <T>(fn: () => Promise<T>): Promise<T> => await fn());

    const result = await service.call("test call", action);

    expect(result).toBe("success");
    expect(mockRetryPolicy.execute).toHaveBeenCalled();
  });

  it("should retry on rate limit errors", async () => {
    const action = jest.fn<() => Promise<string>>();
    mockRetryPolicy.execute.mockImplementation(async <T>(fn: () => Promise<T>, shouldRetry?: (err: any) => boolean): Promise<T> => {
      const error = new Error("Rate limit exceeded");
      if (shouldRetry && shouldRetry(error)) {
        return "retried success" as unknown as T;
      }
      throw error;
    });

    const result = await service.call("test call", action);

    expect(result).toBe("retried success");
  });

  it("should retry on various transient network errors", async () => {
    const transientErrors = [
      "Network timeout",
      "504 Gateway Timeout",
      "502 Bad Gateway",
      "503 Service Unavailable",
      "Internal Server Error (500)",
      "Connection reset by peer",
      "ECONNRESET",
      "ETIMEDOUT"
    ];

    for (const errorMsg of transientErrors) {
      const action = jest.fn<() => Promise<string>>();
      mockRetryPolicy.execute.mockImplementation(async <T>(fn: () => Promise<T>, shouldRetry?: (err: any) => boolean): Promise<T> => {
        const error = new Error(errorMsg);
        if (shouldRetry && shouldRetry(error)) {
          return "success" as unknown as T;
        }
        throw error;
      });

      const result = await service.call("test transient error", action);
      expect(result).toBe("success");
    }
  });

  it("should map rate limit errors to service unavailable app errors", async () => {
    const action = jest.fn<() => Promise<string>>();
    mockRetryPolicy.execute.mockRejectedValue(new Error("Rate limit exceeded"));

    await expect(service.call("test rate limit", action)).rejects.toMatchObject({
      statusCode: 503,
      code: "CONTRACT_RATE_LIMITED",
      message: "Contract provider rate limited the request",
    });
  });

  it("should map revert errors to a contract execution error", async () => {
    const action = jest.fn<() => Promise<string>>();
    mockRetryPolicy.execute.mockRejectedValue(new Error("execution reverted"));

    await expect(service.call("test revert", action)).rejects.toMatchObject({
      statusCode: 422,
      code: "CONTRACT_EXECUTION_REVERTED",
      message: "Contract execution was reverted",
    });
  });

  it("should open the circuit breaker after repeated provider failures", async () => {
    const action = jest.fn<() => Promise<string>>();
    mockRetryPolicy.execute.mockRejectedValue(new Error("Network timeout"));

    for (let i = 0; i < 5; i += 1) {
      await expect(service.call("test network failure", action)).rejects.toMatchObject({
        statusCode: 503,
        code: "CONTRACT_PROVIDER_UNAVAILABLE",
      });
    }

    await expect(service.call("test network failure", action)).rejects.toMatchObject({
      statusCode: 503,
      code: "CONTRACT_PROVIDER_UNAVAILABLE",
      message: "Contract provider temporarily unavailable",
    });

    expect(mockRetryPolicy.execute).toHaveBeenCalledTimes(5);
  });

  it("should not retry on unknown errors", async () => {
    const action = jest.fn<() => Promise<never>>();
    mockRetryPolicy.execute.mockImplementation(async <T>(fn: () => Promise<T>, shouldRetry?: (err: any) => boolean): Promise<T> => {
      const error = new Error("Custom fatal error: Insufficient funds");
      if (shouldRetry && shouldRetry(error)) {
        return "should not happen" as unknown as T;
      }
      throw error;
    });

    await expect(service.call("test fatal error", action)).rejects.toThrow("Custom fatal error: Insufficient funds");
  });

  it("sendTransaction should currently behave like call", async () => {
    const action = jest.fn<() => Promise<string>>().mockResolvedValue("txhash");
    mockRetryPolicy.execute.mockImplementation(async <T>(fn: () => Promise<T>): Promise<T> => await fn());

    const result = await service.sendTransaction("test tx", action);

    expect(result).toBe("txhash");
    expect(mockRetryPolicy.execute).toHaveBeenCalled();
  });
});
