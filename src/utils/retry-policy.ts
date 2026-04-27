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
 * A production-grade retry policy utility for handling transient failures.
 * 
 * This class implements exponential backoff with optional "Full Jitter" strategy
 * to prevent thundering herd problems in distributed systems.
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
    shouldRetry: (error: any) => boolean = () => true
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
          }`
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
