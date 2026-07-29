// @ts-nocheck
// @ts-expect-error - Auto-fixed by script
import { ContractService } from '../contract.service';
// @ts-expect-error - Auto-fixed by script
import { ContractProviderUnavailableError, ContractInvalidRequestError } from '../../errors/contractErrors';
// @ts-expect-error - Auto-fixed by script
import { jest } from '@jest/globals';
import { RetryPolicy } from '../../utils/retry-policy.js';

describe('ContractService', () => {
  let contractService: ContractService;

  beforeEach(() => {
    // Mock RetryPolicy to control retry behavior easily if needed,
    // or just use the real one and mock the action.
    // @ts-expect-error - Auto-fixed by script
    mockRetryPolicy = new RetryPolicy() as jest.Mocked<RetryPolicy>;
    // Actually, let's use the real RetryPolicy but with short delays for tests
    const fastRetryPolicy = new RetryPolicy({
      maxRetries: 0,
      initialDelay: 0,
      backoffFactor: 1,
      maxDelay: 0,
      useJitter: false,
    });
    contractService = new ContractService(fastRetryPolicy);
  });

  test("should retry on transient error", async () => {
    const retryPolicy = new RetryPolicy({
      maxRetries: 1,
      initialDelay: 0,
      backoffFactor: 1,
      maxDelay: 0,
      useJitter: false,
    });
    const retryingService = new ContractService(retryPolicy);
    const action = jest
      .fn()
      .mockRejectedValueOnce(new Error("connection reset")) // Transient
      .mockResolvedValueOnce("success");

    const result = await retryingService.call("test call", action);

    expect(result).toBe("success");
    expect(action).toHaveBeenCalledTimes(2);
  });

  test("should not retry on 4xx error (non-transient)", async () => {
    const action = jest.fn().mockRejectedValue(new Error("invalid address")); // 400

    await expect(contractService.call("test call", action)).rejects.toThrow(
      ContractInvalidRequestError,
    );

    expect(action).toHaveBeenCalledTimes(1);
  });

  test("should trip circuit breaker after 5 failures", async () => {
    const action = jest.fn().mockRejectedValue(new Error("service unavailable")); // 503

    // Fail 5 times
    for (let i = 0; i < 5; i++) {
      await expect(contractService.call("test call", action)).rejects.toThrow();
    }
    expect(action).toHaveBeenCalledTimes(5);

    // 6th call should be blocked by circuit breaker
    await expect(contractService.call("test call", action)).rejects.toThrow(
      ContractProviderUnavailableError,
    );

    // Action should not be called the 6th time
    expect(action).toHaveBeenCalledTimes(5);
  });

  test("should report degraded health when error rate exceeds threshold", async () => {
    const errorAction = jest.fn().mockRejectedValue(new Error("service unavailable"));
    const okAction = jest.fn().mockResolvedValue("ok");

    await expect(contractService.call("test call", errorAction)).rejects.toThrow();
    await expect(contractService.call("test call", errorAction)).rejects.toThrow();
    await expect(contractService.call("test call", errorAction)).rejects.toThrow();
    await contractService.call("test call", okAction);
    await contractService.call("test call", okAction);

    const status = contractService.getHealthStatus();

    expect(status.tier).toBe("degraded");
    expect(status.samples).toBe(5);
    expect(status.errorRate).toBeCloseTo(0.6, 2);
  });

  test("should block sendTransaction when horizon tier is degraded", async () => {
    const errorAction = jest.fn().mockRejectedValue(new Error("service unavailable"));
    const txAction = jest.fn().mockResolvedValue("tx-ok");

    await expect(contractService.call("test call", errorAction)).rejects.toThrow();
    await expect(contractService.call("test call", errorAction)).rejects.toThrow();
    await expect(contractService.call("test call", errorAction)).rejects.toThrow();
    await contractService.call("test call", jest.fn().mockResolvedValue("ok"));
    await contractService.call("test call", jest.fn().mockResolvedValue("ok"));

    await expect(contractService.sendTransaction("submit", txAction)).rejects.toBeInstanceOf(
      ContractProviderUnavailableError,
    );
    expect(txAction).not.toHaveBeenCalled();
  });

  test("should reset circuit breaker after timeout", async () => {
    const action = jest.fn().mockRejectedValue(new Error("service unavailable"));

    // Trip the breaker
    for (let i = 0; i < 5; i++) {
      await expect(contractService.call("test call", action)).rejects.toThrow();
    }

    // Use a fresh clock around the timeout
    const originalNow = Date.now;
    const target = Date.now() + 30001;
    global.Date.now = () => target;

    // Next call should attempt the action again (and fail, but not be blocked by breaker)
    action.mockRejectedValueOnce(new Error("service unavailable"));
    await expect(contractService.call("test call", action)).rejects.toThrow();
    expect(action).toHaveBeenCalledTimes(6);

    global.Date.now = originalNow;
  });

  test("should reset failure counter on success", async () => {
    const action = jest
      .fn()
      .mockRejectedValueOnce(new Error("service unavailable"))
      .mockResolvedValueOnce("success")
      .mockRejectedValueOnce(new Error("service unavailable"))
      .mockRejectedValueOnce(new Error("service unavailable"))
      .mockRejectedValueOnce(new Error("service unavailable"))
      .mockRejectedValueOnce(new Error("service unavailable"));

    // Fail 1 time
    await expect(contractService.call("test call", action)).rejects.toThrow();

    // Succeed 1 time
    await contractService.call("test call", action);

    // Fail 4 more times (total 5 failures, but not consecutive)
    for (let i = 0; i < 4; i++) {
      await expect(contractService.call("test call", action)).rejects.toThrow();
    }

    // Breaker should NOT be open yet because of the success in between
    action.mockRejectedValueOnce(new Error("service unavailable"));
    await expect(contractService.call("test call", action)).rejects.toThrow();
    expect(action).toHaveBeenCalledTimes(7);
  });
});
