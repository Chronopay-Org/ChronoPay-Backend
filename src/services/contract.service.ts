import { RetryPolicy } from "../utils/retry-policy.js";
import { logger } from "../utils/logger.js";

import {
  ContractProviderUnavailableError,
  mapContractError,
  shouldRetryContractError,
} from "../errors/contractErrors.js";

export type HorizonHealthTier = "normal" | "degraded" | "unavailable";

export interface HorizonHealthStatus {
  tier: HorizonHealthTier;
  errorRate: number;
  samples: number;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  lastTransitionAt: number | null;
}

/**
 * Interface for blockchain network details.
 */
export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
}

/**
 * Service to handle blockchain contract interactions with built-in retry logic.
 *
 * This service wraps contract calls and transactions with a retry policy
 * tailored for common transient blockchain network and node errors.
 */
export class ContractService {
  private retryPolicy: RetryPolicy;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private lastTierChangeAt: number | null = null;
  private previousTier: HorizonHealthTier = "normal";
  private readonly healthTierListeners: Array<(status: HorizonHealthStatus) => void> = [];
  private readonly degradedFailureThreshold = 3;
  private readonly failureThreshold = 5;
  private readonly circuitOpenDurationMs = 30_000;
  private readonly probeWindowSize = 10;
  private readonly minProbeSamples = 5;
  private readonly degradedErrorRate = 0.5;
  private readonly probeResults: boolean[] = [];

  /**
   * Initializes the ContractService.
   *
   * @param retryPolicy An optional custom RetryPolicy instance.
   */
  constructor(retryPolicy?: RetryPolicy) {
    this.retryPolicy = retryPolicy ?? new RetryPolicy();
  }

  private isCircuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.addProbeSample(true);
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    this.addProbeSample(false);
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.circuitOpenUntil = Date.now() + this.circuitOpenDurationMs;
    }
  }

  private addProbeSample(success: boolean): void {
    this.probeResults.push(success);
    if (this.probeResults.length > this.probeWindowSize) {
      this.probeResults.shift();
    }
  }

  private calculateErrorRate(): number {
    if (this.probeResults.length === 0) return 0;
    const failures = this.probeResults.filter((sample) => !sample).length;
    return failures / this.probeResults.length;
  }

  getHealthStatus(): HorizonHealthStatus {
    const errorRate = this.calculateErrorRate();
    const isCircuitOpen = this.isCircuitOpen();
    const tier: HorizonHealthTier = isCircuitOpen
      ? "unavailable"
      : this.probeResults.length >= this.minProbeSamples && errorRate >= this.degradedErrorRate
        ? "degraded"
        : "normal";

    return {
      tier,
      errorRate,
      samples: this.probeResults.length,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpenUntil: this.circuitOpenUntil,
      lastTransitionAt: this.lastTierChangeAt,
    };
  }

  registerTierChangeListener(listener: (status: HorizonHealthStatus) => void): void {
    this.healthTierListeners.push(listener);
  }

  private emitTierChange(status: HorizonHealthStatus): void {
    for (const listener of this.healthTierListeners) {
      listener(status);
    }
  }

  private maybeTransitionTier(): void {
    const status = this.getHealthStatus();
    const now = Date.now();
    if (status.tier !== this.previousTier) {
      this.previousTier = status.tier;
      this.lastTierChangeAt = now;
      this.emitTierChange(status);
    }
  }

  /**
   * Executes a read-only contract call with the configured retry policy.
   *
   * @param description Brief description of the call for logging and error reporting.
   * @param action The asynchronous contract call to execute.
   * @returns The result of the contract call.
   * @throws The error from the contract call if retries are exhausted or the error is non-retryable.
   */
  async call<T>(description: string, action: () => Promise<T>): Promise<T> {
    if (this.isCircuitOpen()) {
      throw new ContractProviderUnavailableError();
    }

    try {
      const result = await this.retryPolicy.execute(action, shouldRetryContractError);
      this.recordSuccess();
      this.maybeTransitionTier();
      return result;
    } catch (error) {
      const appError = mapContractError(error);

      if (appError.statusCode >= 500 && appError.code.startsWith("CONTRACT_")) {
        this.recordFailure();
      } else {
        this.recordSuccess();
      }
      this.maybeTransitionTier();

      logger.error(
        {
          upstreamError: error instanceof Error ? error.message : String(error),
          mappedCode: appError.code,
        },
        `Blockchain call failed: ${description}`,
      );

      throw appError;
    }
  }

  /**
   * Executes a contract transaction (state-changing) with the retry policy.
   *
   * @param description Brief description of the transaction for logging.
   * @param action The transaction execution to perform.
   * @returns The transaction result.
   * @throws The error from the transaction if retries are exhausted or the error is non-retryable.
   *
   * @note CAUTION: Retrying transactions requires care. This implementation assumes
   * the provided action handles idempotency or that the errors being retried
   * definitely occurred before the transaction was broadcasted.
   */
  async sendTransaction<T>(description: string, action: () => Promise<T>): Promise<T> {
    const status = this.getHealthStatus();
    if (status.tier !== "normal") {
      throw new ContractProviderUnavailableError(
        "Contract provider writes are temporarily unavailable due to degraded Horizon health",
      );
    }

    return this.call(description, action);
  }
}
