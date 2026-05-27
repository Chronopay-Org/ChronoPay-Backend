import { OutboundTimeoutError, OutboundUnavailableError } from "../errors/OutboundErrors.js";
import { timeoutConfig } from "../config/timeouts.js";
import { getTraceContext } from "../tracing/context.js";
import { logInfo, logWarn, logError } from "./logger.js";

/**
 * Wraps an asynchronous function with a timeout using AbortController.
 * 
 * @param fn - The function to execute, which receives an AbortSignal.
 * @param timeoutMs - The timeout in milliseconds.
 * @param serviceName - The logical name of the service being called (for logging).
 * @returns The result of the function execution.
 * @throws OutboundTimeoutError if the timeout is reached.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  serviceName: string
): Promise<T> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const requestId = getTraceContext()?.traceId || "unknown";
  const startTime = Date.now();

  try {
    const result = await fn(controller.signal);
    const duration = Date.now() - startTime;
    
    // Logging is handled by the caller or specialized here if needed
    return result;
  } catch (err: any) {
    const duration = Date.now() - startTime;
    if (err.name === 'AbortError' || err.message?.includes('AbortError') || err.message?.includes('timeout')) {
      logWarn('outbound_timeout', {
        requestId,
        service: serviceName,
        timeoutMs,
        duration,
      });
      throw new OutboundTimeoutError(serviceName);
    }
    throw err;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Options for the retry helper.
 */
export interface RetryOptions {
  serviceName: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxTotalBudgetMs?: number;
  shouldRetry?: (error: any) => boolean;
}

/**
 * Executes an asynchronous function with budgeted retries and exponential backoff.
 * 
 * @param fn - The function to execute (usually wrapped in withTimeout).
 * @param options - Retry configuration and service identification.
 * @returns The result of the function execution.
 * @throws OutboundUnavailableError if retries are exhausted or budget is exceeded.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    serviceName,
    maxAttempts = timeoutConfig.retry.maxAttempts,
    baseDelayMs = timeoutConfig.retry.baseDelayMs,
    maxTotalBudgetMs = timeoutConfig.retry.maxTotalBudgetMs,
    shouldRetry = isTransientError,
  } = options;

  const requestId = getTraceContext()?.traceId || "unknown";
  const startTime = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const totalElapsed = Date.now() - startTime;
    
    if (totalElapsed >= maxTotalBudgetMs) {
      logError('outbound_budget_exceeded', {
        requestId,
        service: serviceName,
        attempt,
        totalElapsed,
        maxTotalBudgetMs
      });
      throw new OutboundUnavailableError(serviceName);
    }

    try {
      const result = await fn(attempt);
      
      if (attempt > 1) {
        logInfo('outbound_retry_success', {
          requestId,
          service: serviceName,
          attempt,
          duration: Date.now() - startTime
        });
      }
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      if (attempt === maxAttempts || !shouldRetry(error)) {
        logError('outbound_failure', {
          requestId,
          service: serviceName,
          attempt,
          duration,
          error: error instanceof Error ? error.message : String(error)
        });
        
        if (attempt === maxAttempts && shouldRetry(error)) {
          throw new OutboundUnavailableError(serviceName);
        }
        throw error;
      }

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxTotalBudgetMs - (Date.now() - startTime));
      
      logWarn('outbound_retry_attempt', {
        requestId,
        service: serviceName,
        attempt,
        delay,
        error: error instanceof Error ? error.message : String(error)
      });

      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw new OutboundUnavailableError(serviceName);
}

/**
 * Determines if an error is transient and should be retried.
 * Retries on:
 * - OutboundTimeoutError (504)
 * - 5xx errors
 * - Network errors (ECONNRESET, ETIMEDOUT, etc.)
 */
function isTransientError(error: any): boolean {
  if (error instanceof OutboundTimeoutError) return true;
  
  const status = error.statusCode || error.response?.status;
  if (status && status >= 500) return true;
  
  const message = error.message?.toLowerCase() || "";
  return (
    message.includes("network") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("socket hang up") ||
    message.includes("connection reset")
  );
}
