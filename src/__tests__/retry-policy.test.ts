import { jest } from "@jest/globals";
import { RetryPolicy } from "../utils/retry-policy.js";

describe("RetryPolicy", () => {
  // Helper to flush all pending microtasks
  const flushPromises = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(global, "setTimeout");
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("should return the result of the function if it succeeds", async () => {
    const policy = new RetryPolicy({ maxRetries: 3 });
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue("success");

    const result = await policy.execute(fn);

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry the specified number of times on failure", async () => {
    const policy = new RetryPolicy({
      maxRetries: 3,
      initialDelay: 100,
      useJitter: false,
    });
    const fn = jest.fn<() => Promise<never>>().mockRejectedValue(new Error("failure"));

    const promise = policy.execute(fn);

    // Initial call
    await flushPromises();
    
    // 3 retries
    for (let i = 0; i < 3; i++) {
      expect(setTimeout).toHaveBeenCalledTimes(i + 1);
      jest.advanceTimersByTime(10000); // enough to trigger any delay
      await flushPromises();
    }

    await expect(promise).rejects.toThrow("failure");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("should resolve if the function succeeds on a retry", async () => {
    const policy = new RetryPolicy({
      maxRetries: 3,
      initialDelay: 100,
      useJitter: false,
    });
    const fn = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("failure 1"))
      .mockRejectedValueOnce(new Error("failure 2"))
      .mockResolvedValue("success");

    const promise = policy.execute(fn);

    // Attempt 0 fails, calls sleep(100)
    await flushPromises();
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 100);
    jest.advanceTimersByTime(100);
    
    // Attempt 1 fails, calls sleep(200)
    await flushPromises();
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 200);
    jest.advanceTimersByTime(200);

    // Attempt 2 succeeds
    await flushPromises();
    const result = await promise;

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should not retry if the shouldRetry predicate returns false", async () => {
    const policy = new RetryPolicy({ maxRetries: 3 });
    const fn = jest.fn<() => Promise<never>>().mockRejectedValue(new Error("fatal error"));
    const shouldRetry = (err: any) => err.message !== "fatal error";

    await expect(policy.execute(fn, shouldRetry)).rejects.toThrow("fatal error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should apply exponential backoff", async () => {
    const policy = new RetryPolicy({
      maxRetries: 2,
      initialDelay: 100,
      backoffFactor: 2,
      useJitter: false,
    });
    const fn = jest.fn<() => Promise<never>>().mockRejectedValue(new Error("failure"));

    const promise = policy.execute(fn);

    // Fail 1: should wait 100ms
    await flushPromises();
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 100);
    jest.advanceTimersByTime(100);

    // Fail 2: should wait 200ms
    await flushPromises();
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 200);
    jest.advanceTimersByTime(200);

    await flushPromises();
    await expect(promise).rejects.toThrow("failure");
  });

  it("should respect maxDelay", async () => {
    const policy = new RetryPolicy({
      maxRetries: 3,
      initialDelay: 5000,
      backoffFactor: 2,
      maxDelay: 8000,
      useJitter: false,
    });
    const fn = jest.fn<() => Promise<never>>().mockRejectedValue(new Error("failure"));

    const promise = policy.execute(fn);

    // Fail 1: 5000ms
    await flushPromises();
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 5000);
    jest.advanceTimersByTime(5000);

    // Fail 2: min(5000 * 2, 8000) = 8000ms
    await flushPromises();
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 8000);
    jest.advanceTimersByTime(8000);

    // Fail 3: min(8000 * 2, 8000) = 8000ms
    await flushPromises();
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 8000);
    jest.advanceTimersByTime(8000);

    await flushPromises();
    await expect(promise).rejects.toThrow("failure");
  });

  it("should apply jitter when enabled", async () => {
    const policy = new RetryPolicy({
      maxRetries: 1,
      initialDelay: 1000,
      useJitter: true,
    });
    const fn = jest.fn<() => Promise<never>>().mockRejectedValue(new Error("failure"));

    // Mock Math.random to return 0.5
    jest.spyOn(Math, "random").mockReturnValue(0.5);

    const promise = policy.execute(fn);

    await flushPromises();
    // With Full Jitter and 0.5 random, delay should be floor(1000 * 0.5) = 500
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 500);
    
    jest.advanceTimersByTime(500);
    await flushPromises();
    await expect(promise).rejects.toThrow("failure");
  });
});
