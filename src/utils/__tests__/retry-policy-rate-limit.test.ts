import { jest } from "@jest/globals";
import {
  RetryPolicy,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_RATE_LIMIT_RETRY_CONFIG,
  computeRateLimitDelay,
  isRateLimitError,
  RateLimitRetryConfig,
} from "../../utils/retry-policy.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRlConfig(overrides: Partial<RateLimitRetryConfig> = {}): RateLimitRetryConfig {
  return { ...DEFAULT_RATE_LIMIT_RETRY_CONFIG, ...overrides };
}

// ─── computeRateLimitDelay ────────────────────────────────────────────────────

describe("computeRateLimitDelay", () => {
  it("honours a positive retryAfterMs hint from headers", () => {
    const delay = computeRateLimitDelay(0, makeRlConfig(), 5_000);
    // Delay should be at least 5000 (hint) and at most 5500 (10% jitter cap)
    expect(delay).toBeGreaterThanOrEqual(5_000);
    expect(delay).toBeLessThanOrEqual(5_500);
  });

  it("ignores a zero retryAfterMs hint and falls back to exponential", () => {
    const delay = computeRateLimitDelay(0, makeRlConfig({ jitterFactor429: 0 }), 0);
    expect(delay).toBe(DEFAULT_RATE_LIMIT_RETRY_CONFIG.initialDelay429);
  });

  it("ignores negative retryAfterMs and falls back to exponential", () => {
    const delay = computeRateLimitDelay(0, makeRlConfig({ jitterFactor429: 0 }), -1_000);
    expect(delay).toBe(DEFAULT_RATE_LIMIT_RETRY_CONFIG.initialDelay429);
  });

  it("applies exponential growth across attempts (no jitter)", () => {
    const cfg = makeRlConfig({ jitterFactor429: 0 });
    const d0 = computeRateLimitDelay(0, cfg);
    const d1 = computeRateLimitDelay(1, cfg);
    const d2 = computeRateLimitDelay(2, cfg);
    expect(d1).toBe(d0 * cfg.backoffFactor429);
    expect(d2).toBe(d1 * cfg.backoffFactor429);
  });

  it("caps delay at maxDelay429", () => {
    const cfg = makeRlConfig({ maxDelay429: 2_000, jitterFactor429: 0 });
    // Large attempt to force overflow
    const delay = computeRateLimitDelay(100, cfg);
    expect(delay).toBeLessThanOrEqual(2_000);
  });

  it("returns a non-negative delay for attempt 0 with defaults", () => {
    const delay = computeRateLimitDelay(0, makeRlConfig());
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it("respects jitterFactor of zero (deterministic output)", () => {
    const cfg = makeRlConfig({ jitterFactor429: 0, initialDelay429: 500, backoffFactor429: 2 });
    const delays = Array.from({ length: 10 }, () => computeRateLimitDelay(1, cfg));
    // All values should be the same when jitter is disabled
    expect(new Set(delays).size).toBe(1);
  });

  it("adds some spread when jitterFactor is positive", () => {
    const cfg = makeRlConfig({ jitterFactor429: 0.5, initialDelay429: 1_000 });
    const delays = new Set(Array.from({ length: 20 }, () => computeRateLimitDelay(0, cfg)));
    // With 50% jitter on a 1000 ms base there should be multiple distinct values
    expect(delays.size).toBeGreaterThan(1);
  });
});

// ─── isRateLimitError ─────────────────────────────────────────────────────────

describe("isRateLimitError", () => {
  it("returns true for an error with 'rate limit' in the message", () => {
    expect(isRateLimitError(new Error("rate limit exceeded"))).toBe(true);
  });

  it("returns true for an error with 'Rate Limit' (case-insensitive)", () => {
    expect(isRateLimitError(new Error("Rate Limit hit"))).toBe(true);
  });

  it("returns true for an error with 'too many requests' in the message", () => {
    expect(isRateLimitError(new Error("Too Many Requests"))).toBe(true);
  });

  it("returns true for an object with statusCode 429", () => {
    expect(isRateLimitError({ statusCode: 429, message: "oops" })).toBe(true);
  });

  it("returns true for an object with response.status 429", () => {
    expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
  });

  it("returns false for a generic error", () => {
    expect(isRateLimitError(new Error("connection reset"))).toBe(false);
  });

  it("returns false for a 500-status object", () => {
    expect(isRateLimitError({ statusCode: 500 })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isRateLimitError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isRateLimitError(undefined)).toBe(false);
  });

  it("returns false for a plain string", () => {
    expect(isRateLimitError("rate limit")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isRateLimitError(429)).toBe(false);
  });
});

// ─── RetryPolicy.execute (existing behaviour preserved) ──────────────────────

describe("RetryPolicy.execute", () => {
  it("resolves immediately when the function succeeds on the first try", async () => {
    const policy = new RetryPolicy({ maxRetries: 3, initialDelay: 0, useJitter: false });
    const fn = jest.fn<() => Promise<string>>().mockResolvedValueOnce("ok");
    const result = await policy.execute(fn as () => Promise<string>);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to maxRetries and then throws", async () => {
    const policy = new RetryPolicy({
      maxRetries: 2,
      initialDelay: 0,
      backoffFactor: 1,
      maxDelay: 0,
      useJitter: false,
    });
    const fn = jest.fn<() => Promise<never>>().mockRejectedValue(new Error("fail"));

    await expect(policy.execute(fn as () => Promise<never>)).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("stops retrying when shouldRetry returns false", async () => {
    const policy = new RetryPolicy({ maxRetries: 5, initialDelay: 0, useJitter: false });
    const fn = jest.fn<() => Promise<never>>().mockRejectedValue(new Error("non-retryable"));
    const shouldRetry = jest.fn(() => false);

    await expect(policy.execute(fn as () => Promise<never>, shouldRetry)).rejects.toThrow("non-retryable");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });
});

// ─── RetryPolicy.executeWithRateLimit ─────────────────────────────────────────

describe("RetryPolicy.executeWithRateLimit", () => {
  it("resolves immediately when the function succeeds on the first try", async () => {
    const policy = new RetryPolicy({ maxRetries: 0, useJitter: false, initialDelay: 0 });
    const fn = jest.fn<() => Promise<string>>().mockResolvedValueOnce("success");

    const result = await policy.executeWithRateLimit(fn as () => Promise<string>);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on rate-limit errors using 429-specific budget", async () => {
    const policy = new RetryPolicy({ maxRetries: 0, useJitter: false, initialDelay: 0 });

    const rlError = Object.assign(new Error("rate limit exceeded"), { statusCode: 429 });
    const fn = jest.fn<() => Promise<string>>();
    (fn as jest.Mock)
      .mockRejectedValueOnce(rlError)
      .mockRejectedValueOnce(rlError)
      .mockResolvedValueOnce("ok");

    const result = await policy.executeWithRateLimit(fn as () => Promise<string>, {
      maxRetries429: 3,
      initialDelay429: 0,
      backoffFactor429: 1,
      maxDelay429: 10,
      jitterFactor429: 0,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("calls onRateLimit hook with the attempt index and error", async () => {
    const policy = new RetryPolicy({ maxRetries: 0, useJitter: false, initialDelay: 0 });

    const rlError = Object.assign(new Error("rate limit exceeded"), { statusCode: 429 });
    const fn = jest.fn<() => Promise<string>>();
    (fn as jest.Mock)
      .mockRejectedValueOnce(rlError)
      .mockResolvedValueOnce("ok");

    const onRateLimit = jest.fn<(attempt: number, err: unknown) => Promise<number | undefined>>(
      async () => 0,
    );

    await policy.executeWithRateLimit(fn as () => Promise<string>, {
      maxRetries429: 2,
      initialDelay429: 0,
      backoffFactor429: 1,
      maxDelay429: 10,
      jitterFactor429: 0,
    }, onRateLimit);
    expect(onRateLimit).toHaveBeenCalledTimes(1);
    expect(onRateLimit).toHaveBeenCalledWith(0, rlError);
  });

  it("honours retryAfterMs returned by onRateLimit callback", async () => {
    const policy = new RetryPolicy({ maxRetries: 0, useJitter: false, initialDelay: 0 });

    const rlError = Object.assign(new Error("rate limit exceeded"), { statusCode: 429 });
    const fn = jest.fn<() => Promise<string>>();
    (fn as jest.Mock)
      .mockRejectedValueOnce(rlError)
      .mockResolvedValueOnce("ok");

    const onRateLimit = jest.fn<() => Promise<number>>(async () => 0);

    const result = await policy.executeWithRateLimit(fn as () => Promise<string>, {
      maxRetries429: 1,
      initialDelay429: 0,
      backoffFactor429: 1,
      maxDelay429: 10,
      jitterFactor429: 0,
    }, onRateLimit);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts 429 budget and re-throws the last rate-limit error", async () => {
    const policy = new RetryPolicy({ maxRetries: 0, useJitter: false, initialDelay: 0 });

    const rlError = Object.assign(new Error("rate limit exceeded"), { statusCode: 429 });
    const fn = jest.fn<() => Promise<never>>().mockRejectedValue(rlError);

    await expect(
      policy.executeWithRateLimit(fn as () => Promise<never>, {
        maxRetries429: 2,
        initialDelay429: 0,
        backoffFactor429: 1,
        maxDelay429: 10,
        jitterFactor429: 0,
      }),
    ).rejects.toThrow("rate limit exceeded");
    // initial attempt + 2 rate-limit retries = 3 total calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("treats non-rate-limit errors as standard retries", async () => {
    const policy = new RetryPolicy({
      maxRetries: 2,
      initialDelay: 0,
      backoffFactor: 1,
      maxDelay: 10,
      useJitter: false,
    });

    const networkError = new Error("network reset");
    const fn = jest.fn<() => Promise<string>>();
    (fn as jest.Mock)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce("ok");

    const result = await policy.executeWithRateLimit(fn as () => Promise<string>, {
      maxRetries429: 0,
      initialDelay429: 0,
      backoffFactor429: 1,
      maxDelay429: 10,
      jitterFactor429: 0,
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ─── Backward-compatibility: DEFAULT_RETRY_CONFIG unchanged ──────────────────

describe("DEFAULT_RETRY_CONFIG backward-compatibility", () => {
  it("still exports the original defaults", () => {
    expect(DEFAULT_RETRY_CONFIG).toEqual({
      maxRetries: 3,
      initialDelay: 1000,
      backoffFactor: 2,
      maxDelay: 10000,
      useJitter: true,
    });
  });
});

describe("DEFAULT_RATE_LIMIT_RETRY_CONFIG", () => {
  it("exports sane defaults for the 429 policy", () => {
    expect(DEFAULT_RATE_LIMIT_RETRY_CONFIG.maxRetries429).toBeGreaterThan(0);
    expect(DEFAULT_RATE_LIMIT_RETRY_CONFIG.initialDelay429).toBeGreaterThan(0);
    expect(DEFAULT_RATE_LIMIT_RETRY_CONFIG.backoffFactor429).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_RATE_LIMIT_RETRY_CONFIG.maxDelay429).toBeGreaterThan(
      DEFAULT_RATE_LIMIT_RETRY_CONFIG.initialDelay429,
    );
    expect(DEFAULT_RATE_LIMIT_RETRY_CONFIG.jitterFactor429).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_RATE_LIMIT_RETRY_CONFIG.jitterFactor429).toBeLessThanOrEqual(1);
  });
});
