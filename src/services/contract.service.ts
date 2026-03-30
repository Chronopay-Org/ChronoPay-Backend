import { RetryPolicy } from "../utils/retry-policy.js";

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

  /**
   * Initializes the ContractService.
   * 
   * @param retryPolicy An optional custom RetryPolicy instance.
   */
  constructor(retryPolicy?: RetryPolicy) {
    this.retryPolicy = retryPolicy ?? new RetryPolicy();
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
    try {
      return await this.retryPolicy.execute(action, (error) => {
        // Retry on transient network/node errors
        const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        
        return (
          errorMessage.includes("rate limit") ||
          errorMessage.includes("timeout") ||
          errorMessage.includes("network") ||
          errorMessage.includes("504") || // Gateway Timeout
          errorMessage.includes("502") || // Bad Gateway
          errorMessage.includes("503") || // Service Unavailable
          errorMessage.includes("500") || // Internal Server Error (sometimes transient in RPCs)
          errorMessage.includes("connection reset") ||
          errorMessage.includes("econnreset") ||
          errorMessage.includes("etimedout")
        );
      });
    } catch (error) {
       console.error(`Blockchain call failed after retries: ${description}`, error);
       throw error;
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
    // For transactions, we reuse the same logic for now, but in a production environment,
    // we might want to be more specific about which errors are safe to retry 
    // without risk of double-submission (e.g., only connectivity errors before broadcast).
    return this.call(description, action);
  }
}
