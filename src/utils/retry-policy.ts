/**
 * Configuration for the RetryPolicy.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts. */
  maxRetries: number;
  /** Initial delay in milliseconds before the first retry. */
  initialDelay: number;
  /** Factor by which the delay increases with each retry. */
  backoffFactor: number;
  /** Maximum delay in milliseconds between retries. */
  maxDelay: number;
  /** Whether to add randomized jitter to the delay. */
  useJitter: boolean;
}

/**
 * Default configuration for the RetryPolicy.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelay: 1000,
  backoffFactor: 2,
  maxDelay: 10000,
  useJitter: true,
};

/**
 * Configuration for 429-specific retry behaviour.
 *
 * When a request is rejected with HTTP 429 (Too Many Requests), the standard
 * backoff is replaced by a purpose-built schedule that:
 *   1. Honours the `Retry-After` / `X-RateLimit-Reset` header when present.
 *   2. Falls back to jittered exponential backoff capped at `maxDelay429`.
 *
 * Keeping the 429 policy separate lets callers tighten (or widen) the
 * rate-limit response window without affecting the general transient-error
 * schedule.
 */
export interface RateLimitRetryConfig {
  /** Maximum number of 429-specific retry attempts (default: 5). */
  maxRetries429: number;
  /** Initial base delay (ms) for the 429 backoff schedule (default: 1 000). */
  initialDelay429: number;
  /** Backoff factor applied after each 429 (default: 2). */
  backoffFactor429: number;
  /**
   * Hard cap on the computed delay in milliseconds (default: 60 000).
   * Prevents waiting longer than a full rate-limit window.
   */
  maxDelay429: number;
  /**
   * Maximum jitter added on top of the base delay, expressed as a fraction of
   * the base delay value (default: 0.25 → up to ±25 % jitter).
   * Set to 0 to disable jitter and use pure exponential backoff.
   */
  jitterFactor429: number;
}

/** Sensible defaults for rate-limit retry behaviour. */
export const DEFAULT_RATE_LIMIT_RETRY_CONFIG: RateLimitRetryConfig = {
  maxRetries429: 5,
  initialDelay429: 1_000,
  backoffFactor429: 2,
  maxDelay429: 60_000,
  jitterFactor429: 0.25,
};

/**
 * Compute the delay (ms) before the next attempt after a 429 response.
 *
 * Priority:
 *   1. `retryAfterMs` — from `Retry-After` / `X-RateLimit-Reset` header.
 *   2. Jittered exponential backoff capped at `maxDelay429`.
 *
 * @param attempt         Zero-based attempt index (0 = first retry).
 * @param config          Rate-limit retry configuration.
 * @param retryAfterMs    Optional hint from a response header (milliseconds).
 * @returns               Delay in milliseconds (always >= 0).
 */
export function computeRateLimitDelay(
  attempt: number,
  config: RateLimitRetryConfig,
  retryAfterMs?: number,
): number {
  // Honour a server-supplied hint when present and positive.
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    // Add a small proportional jitter (≤ 10 %) so concurrent callers don't all
    // resume at exactly the same instant.
    const headerJitter = Math.floor(Math.random() * retryAfterMs * 0.1);
    return retryAfterMs + headerJitter;
  }

  // Exponential backoff: initialDelay429 * backoffFactor429^attempt
  const base = Math.min(
    config.initialDelay429 * Math.pow(config.backoffFactor429, attempt),
    config.maxDelay429,
  );

  // "Equal Jitter" (half fixed, half random) spreads thundering herds.
  const jitter =
    config.jitterFactor429 > 0
      ? Math.floor(Math.random() * base * config.jitterFactor429)
      : 0;

  return Math.min(base + jitter, config.maxDelay429);
}

/**
 * Returns `true` when the error represents an HTTP 429 rate-limit response
 * from Horizon (or any other caller-supplied 429 signal).
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;

  // ContractRateLimitError and HorizonHttpError both include the string
  // "rate limit" in their message (see contractErrors.ts).
  if (typeof e.message === "string") {
    const lower = e.message.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("too many requests")) return true;
  }

  // Direct status-code check for HorizonHttpError-style objects.
  if (e.statusCode === 429) return true;

  // Express-style response
  if (
    typeof e.response === "object" &&
    e.response !== null &&
    (e.response as Record<string, unknown>).status === 429
  )
    return true;

  return false;
}

/**
 * A production-grade retry policy utility for handling transient failures.
 *
 * This class implements exponential backoff with optional "Full Jitter" strategy
 * to prevent thundering herd problems in distributed systems.
 *
 * **429 / rate-limit handling**
 *
 * When `rateLimitConfig` is provided (or the defaults are used via
 * `executeWithRateLimit`), the policy maintains a *separate* retry budget and
 * delay schedule for rate-limit errors.  The caller can supply a
 * `retryAfterMs` hint (parsed from `Retry-After` / `X-RateLimit-Reset`
 * headers) via the `onRateLimit` callback or by throwing a structured error
 * that carries a `retryAfterMs` property.
 */
export class RetryPolicy {
  private config: RetryConfig;

  /**
   * Creates a new RetryPolicy with the given configuration.
   *
   * @param config Partial configuration to override defaults.
   */
  constructor(config: Partial<RetryConfig> = {}) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * Executes an asynchronous function with the retry policy.
   *
   * @param fn The asynchronous function to execute.
   * @param shouldRetry A predicate to determine if an error should trigger a retry.
   *                    Defaults to always retrying if an error is thrown.
   * @returns The result of the asynchronous function.
   * @throws The last error encountered if all retry attempts fail or if shouldRetry returns false.
   */
  async execute<T>(
    fn: () => Promise<T>,
    shouldRetry: (error: unknown) => boolean = () => true,
  ): Promise<T> {
    let delay = this.config.initialDelay;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt === this.config.maxRetries || !shouldRetry(error)) {
          throw error;
        }

        const currentDelay = this.calculateDelay(delay);
        console.warn(
          `Retry attempt ${attempt + 1}/${this.config.maxRetries} after ${currentDelay}ms due to: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        await this.sleep(currentDelay);

        // Increase the base delay for the next attempt, capped at maxDelay
        delay = Math.min(delay * this.config.backoffFactor, this.config.maxDelay);
      }
    }

    // This part is rarely reached because the loop throws the error in the last attempt
    throw new Error("Retry failed surprisingly");
  }

  /**
   * Executes an asynchronous function with dedicated 429/rate-limit retry
   * handling on top of the standard retry policy.
   *
   * The standard `shouldRetry` predicate is applied first.  If the error is
   * additionally identified as a rate-limit error via `isRateLimitError`, the
   * 429-specific delay schedule is used instead of the standard backoff.
   *
   * @param fn              The asynchronous function to execute.
   * @param rlConfig        Rate-limit retry configuration (defaults apply when omitted).
   * @param onRateLimit     Optional hook called before each rate-limit retry.
   *                        The hook may return a `retryAfterMs` value to override
   *                        the computed delay (e.g. parsed from response headers).
   * @returns               The result of the asynchronous function.
   * @throws                The last error if all attempts (standard + 429) are exhausted.
   */
  async executeWithRateLimit<T>(
    fn: () => Promise<T>,
    rlConfig: Partial<RateLimitRetryConfig> = {},
    onRateLimit?: (attempt: number, error: unknown) => Promise<number | undefined>,
  ): Promise<T> {
    const resolvedRlConfig: RateLimitRetryConfig = {
      ...DEFAULT_RATE_LIMIT_RETRY_CONFIG,
      ...rlConfig,
    };

    let standardDelay = this.config.initialDelay;
    let rl429Attempt = 0;

    // Total attempts = standard retries + 429-specific retries (independent budgets)
    const totalAttempts = this.config.maxRetries + resolvedRlConfig.maxRetries429 + 1;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const isRl = isRateLimitError(error);

        if (isRl && rl429Attempt < resolvedRlConfig.maxRetries429) {
          // Use the 429-specific retry budget.
          let retryAfterMs: number | undefined;
          if (onRateLimit) {
            retryAfterMs = await onRateLimit(rl429Attempt, error);
          }

          const delay = computeRateLimitDelay(rl429Attempt, resolvedRlConfig, retryAfterMs);
          rl429Attempt++;

          console.warn(
            `Rate-limit retry ${rl429Attempt}/${resolvedRlConfig.maxRetries429} after ${delay}ms`,
          );
          await this.sleep(delay);
          continue;
        }

        // Standard retry path (non-429 or 429 budget exhausted).
        const standardAttemptsRemaining =
          this.config.maxRetries - (attempt - rl429Attempt);

        if (standardAttemptsRemaining <= 0) {
          throw error;
        }

        const currentDelay = this.calculateDelay(standardDelay);
        console.warn(
          `Retry attempt after ${currentDelay}ms due to: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.sleep(currentDelay);
        standardDelay = Math.min(
          standardDelay * this.config.backoffFactor,
          this.config.maxDelay,
        );
      }
    }

    throw new Error("Retry policy exhausted all attempts");
  }

  /**
   * Calculates the delay for the next retry attempt.
   *
   * If jitter is enabled, it uses "Full Jitter": random between 0 and baseDelay.
   * This is effective for spreading out retries in high-concurrency scenarios.
   */
  private calculateDelay(baseDelay: number): number {
    if (!this.config.useJitter) {
      return baseDelay;
    }
    // Full Jitter: randomize the delay between 0 and the current base delay
    return Math.floor(Math.random() * baseDelay);
  }

  /**
   * Helper to wait for a specified duration using a promise-based delay.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
