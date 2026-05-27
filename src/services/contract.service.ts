import { RetryPolicy } from "../utils/retry-policy.js";
import {
  ContractProviderUnavailableError,
  mapContractError,
  shouldRetryContractError,
} from "../errors/contractErrors.js";

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
  private readonly failureThreshold = 5;
  private readonly circuitOpenDurationMs = 30_000;

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
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.circuitOpenUntil = Date.now() + this.circuitOpenDurationMs;
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
      return result;
    } catch (error) {
      const appError = mapContractError(error);

      if (appError.statusCode >= 500 && appError.code.startsWith("CONTRACT_")) {
        this.recordFailure();
      } else {
        this.recordSuccess();
      }

      console.error(
        `Blockchain call failed: ${description}`,
        {
          upstreamError: error instanceof Error ? error.message : String(error),
          mappedCode: appError.code,
        },
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
    return this.call(description, action);
  }
}
