/**
 * Payout Retry Backoff Policy
 * ---------------------------
 *
 * Implements the "Full Jitter" exponential backoff algorithm described in
 * https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 *
 *   delay = random_between(0, min(ceiling, base * multiplier^attempt))
 *
 * Key properties:
 *  - Full jitter spreads concurrent retriers uniformly across the window,
 *    preventing thundering-herd on recovery.
 *  - A per-provider `maxDelayCeilingMs` caps the computed cap before jitter is
 *    applied, so no individual provider can impose unbounded waits.
 *  - When `maxDelayCeilingMs < baseDelayMs` the ceiling takes effect immediately
 *    (attempt 0 cap = ceiling, not base), so the contract is always honoured.
 *  - All parameters are validated at construction time.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Retry configuration for a single payout provider.
 *
 * The per-provider ceiling is the central addition over the generic
 * `RetryPolicy` in `src/utils/retry-policy.ts`: different rail providers
 * (e.g. ACH, SEPA, crypto rails) can have vastly different SLAs, so each
 * should impose its own maximum inter-attempt wait.
 */
export interface ProviderRetryConfig {
  /**
   * Human-readable provider identifier (e.g. "ach", "sepa", "stellar").
   * Used only for logging and metric labels — not interpreted by the algorithm.
   */
  providerId: string;

  /**
   * Base delay (ms) for attempt 0.
   * Must be a positive integer.
   * @default 1000
   */
  baseDelayMs: number;

  /**
   * Exponential multiplier applied per attempt.
   * Must be >= 1.
   * @default 2
   */
  multiplier: number;

  /**
   * Hard ceiling (ms) on the cap before jitter is applied.
   * The actual wait is always in [0, min(ceiling, base * multiplier^attempt)].
   * Must be a positive integer; if < baseDelayMs the ceiling applies from
   * attempt 0 onward.
   * @default 30_000
   */
  maxDelayCeilingMs: number;

  /**
   * Maximum number of retry attempts (not counting the initial try).
   * Must be a non-negative integer.
   * @default 5
   */
  maxRetries: number;
}

/**
 * Result returned by `calculatePayoutBackoffDelay`.
 * Separating the cap from the final delay aids observability and testing.
 */
export interface BackoffDelayResult {
  /** The cap before jitter was applied: min(ceiling, base * multiplier^attempt). */
  capMs: number;
  /** The final jittered delay: random_between(0, capMs). */
  delayMs: number;
  /** Attempt number this was calculated for (0-indexed). */
  attempt: number;
  /** The provider id this was calculated for. */
  providerId: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_PROVIDER_RETRY_CONFIG: Omit<ProviderRetryConfig, "providerId"> = {
  baseDelayMs: 1_000,
  multiplier: 2,
  maxDelayCeilingMs: 30_000,
  maxRetries: 5,
};

// ─── Per-provider ceiling registry ────────────────────────────────────────────

/**
 * Registry that maps `providerId` strings to their retry config.
 *
 * In production, populate this at application start from environment variables
 * or a config service.  The registry is module-level so it can be shared
 * across the scheduler without dependency injection overhead.
 *
 * Example:
 * ```ts
 * providerRetryRegistry.set("ach",     { providerId: "ach",     maxDelayCeilingMs: 60_000, ... });
 * providerRetryRegistry.set("stellar", { providerId: "stellar", maxDelayCeilingMs: 10_000, ... });
 * ```
 */
export const providerRetryRegistry = new Map<string, ProviderRetryConfig>();

/**
 * Look up a provider's retry config, falling back to the defaults when no
 * explicit entry is registered.
 */
export function getProviderRetryConfig(providerId: string): ProviderRetryConfig {
  const registered = providerRetryRegistry.get(providerId);
  if (registered) return registered;
  return { providerId, ...DEFAULT_PROVIDER_RETRY_CONFIG };
}

// ─── Algorithm ────────────────────────────────────────────────────────────────

/**
 * Validate a `ProviderRetryConfig` and throw a descriptive `Error` for any
 * invalid field.  Called by `calculatePayoutBackoffDelay` so invariants are
 * always checked, even if the caller built the config inline.
 */
export function validateProviderRetryConfig(cfg: ProviderRetryConfig): void {
  if (!cfg.providerId || typeof cfg.providerId !== "string") {
    throw new Error("ProviderRetryConfig: providerId must be a non-empty string");
  }
  if (!Number.isInteger(cfg.baseDelayMs) || cfg.baseDelayMs <= 0) {
    throw new Error(
      `ProviderRetryConfig [${cfg.providerId}]: baseDelayMs must be a positive integer, got ${cfg.baseDelayMs}`,
    );
  }
  if (typeof cfg.multiplier !== "number" || cfg.multiplier < 1) {
    throw new Error(
      `ProviderRetryConfig [${cfg.providerId}]: multiplier must be >= 1, got ${cfg.multiplier}`,
    );
  }
  if (!Number.isInteger(cfg.maxDelayCeilingMs) || cfg.maxDelayCeilingMs <= 0) {
    throw new Error(
      `ProviderRetryConfig [${cfg.providerId}]: maxDelayCeilingMs must be a positive integer, got ${cfg.maxDelayCeilingMs}`,
    );
  }
  if (!Number.isInteger(cfg.maxRetries) || cfg.maxRetries < 0) {
    throw new Error(
      `ProviderRetryConfig [${cfg.providerId}]: maxRetries must be a non-negative integer, got ${cfg.maxRetries}`,
    );
  }
}

/**
 * Pure function — calculate the jittered backoff delay for a given attempt.
 *
 * Algorithm (Full Jitter):
 *   cap   = min(maxDelayCeilingMs, baseDelayMs * multiplier^attempt)
 *   delay = uniform_random(0, cap)           // endpoint-inclusive
 *
 * The cap is clamped to [0, maxDelayCeilingMs] so it is always honoured
 * regardless of attempt number or multiplier magnitude.
 *
 * @param attempt  0-indexed attempt counter (0 = first retry, 1 = second…).
 * @param config   Provider retry config.  Validated before use.
 * @param random   Pluggable random source (defaults to `Math.random`).
 *                 Must return a value in [0, 1).  Inject a seeded PRNG in
 *                 tests to produce deterministic results.
 */
export function calculatePayoutBackoffDelay(
  attempt: number,
  config: ProviderRetryConfig,
  random: () => number = Math.random,
): BackoffDelayResult {
  validateProviderRetryConfig(config);

  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(
      `calculatePayoutBackoffDelay [${config.providerId}]: attempt must be a non-negative integer, got ${attempt}`,
    );
  }

  // Unclamped exponential cap — use safe arithmetic to avoid Infinity on
  // extreme inputs (very high attempt counts or large multipliers).
  const exponentialCap = config.baseDelayMs * Math.pow(config.multiplier, attempt);

  // Apply provider ceiling — this is the contract the issue requires us to honour.
  const capMs = Math.min(config.maxDelayCeilingMs, exponentialCap);

  // Full jitter: uniform sample from [0, capMs].
  // We use Math.floor to produce integer milliseconds, matching setTimeout
  // granularity and keeping the arithmetic exact.
  const delayMs = Math.floor(random() * (capMs + 1));

  return { capMs, delayMs, attempt, providerId: config.providerId };
}

/**
 * Return `true` when the settlement/payout should be retried given its current
 * attempt count and the provider's configured `maxRetries`.
 */
export function isRetryable(attempt: number, config: ProviderRetryConfig): boolean {
  return attempt < config.maxRetries;
}
