/**
 * Structured Logging Utilities for ChronoPay Backend
 *
 * Provides utilities for safe, consistent logging across the application
 * with built-in security features and performance optimizations.
 */

import { logger, LogContext, LogLevel } from "./logger.js";

/**
 * Performance timing utility for measuring operation duration
 */
export class PerformanceTimer {
  private startTime: number;
  private context: LogContext;

  constructor(operation: string, context?: LogContext) {
    this.startTime = Date.now();
    this.context = { operation, ...context };
  }

  /**
   * Logs the duration of the operation
   */
  end(message: string = "Operation completed"): void {
    const duration = Date.now() - this.startTime;
    logger.info(
      {
        ...this.context,
        duration_ms: duration,
      },
      `${message} in ${duration}ms`
    );
  }

  /**
   * Logs the duration with an error
   */
  endWithError(error: Error, message: string = "Operation failed"): void {
    const duration = Date.now() - this.startTime;
    logger.error(
      {
        ...this.context,
        duration_ms: duration,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      },
      message
    );
  }
}

/**
 * Creates a scoped logger for a specific module or component
 * Automatically attaches module context to all logs
 *
 * @param moduleName - Name of the module/component
 * @param additionalContext - Optional additional context
 */
export const createScopedLogger = (
  moduleName: string,
  additionalContext?: LogContext
) => {
  return logger.child({
    module: moduleName,
    ...additionalContext,
  });
};

/**
 * Logs API call details with standardized format
 * Includes request/response metadata and timing
 */
export const logApiCall = (
  method: string,
  endpoint: string,
  statusCode: number,
  durationMs: number,
  context?: LogContext
): void => {
  const level: LogLevel =
    statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";

  logger[level](
    {
      api_call: true,
      method,
      endpoint,
      status_code: statusCode,
      duration_ms: durationMs,
      ...context,
    },
    `API ${method} ${endpoint} [${statusCode}]`
  );
};

/**
 * Logs database operations with query sanitization
 * Prevents logging sensitive data in queries
 */
export const logDbOperation = (
  operation: string,
  table: string,
  durationMs: number,
  rowCount?: number,
  context?: LogContext
): void => {
  logger.debug(
    {
      db_operation: true,
      operation,
      table,
      duration_ms: durationMs,
      row_count: rowCount,
      ...context,
    },
    `DB ${operation} on ${table} in ${durationMs}ms`
  );
};

/**
 * Logs external API calls with timing and error handling
 */
export const logExternalCall = (
  serviceName: string,
  endpoint: string,
  success: boolean,
  durationMs: number,
  statusCode?: number,
  error?: Error
): void => {
  const context = {
    external_call: true,
    service_name: serviceName,
    endpoint,
    success,
    duration_ms: durationMs,
    status_code: statusCode,
  };

  if (success) {
    logger.info(context, `External call to ${serviceName} succeeded`);
  } else {
    logger.error(
      {
        ...context,
        error: error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : undefined,
      },
      `External call to ${serviceName} failed`
    );
  }
};

/**
 * Logs security-related events with enhanced detail
 * Used for authentication, authorization, and audit trails
 */
export const logSecurityEvent = (
  eventType: string,
  userId?: string,
  success: boolean = true,
  details?: Record<string, unknown>
): void => {
  const level = success ? "info" : "warn";

  logger[level](
    {
      security_event: true,
      event_type: eventType,
      user_id: userId,
      success,
      timestamp: new Date().toISOString(),
      ...details,
    },
    `Security event: ${eventType}`
  );
};

/**
 * Logs slow operations that exceed a threshold
 * Default threshold: 1000ms (1 second)
 */
export const logSlowOperation = (
  operation: string,
  durationMs: number,
  thresholdMs: number = 1000,
  context?: LogContext
): void => {
  if (durationMs > thresholdMs) {
    logger.warn(
      {
        slow_operation: true,
        operation,
        duration_ms: durationMs,
        threshold_ms: thresholdMs,
        exceeded_by_ms: durationMs - thresholdMs,
        ...context,
      },
      `Slow operation detected: ${operation} took ${durationMs}ms (threshold: ${thresholdMs}ms)`
    );
  }
};

/**
 * Batch logging utility for grouping related logs
 * Useful for operations that generate multiple log entries
 */
export const logBatch = (
  entries: Array<{ level: LogLevel; message: string; context?: LogContext }>
): void => {
  const batchId = `batch_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  entries.forEach((entry, index) => {
    logger[entry.level](
      {
        batch_id: batchId,
        batch_index: index,
        batch_size: entries.length,
        ...entry.context,
      },
      entry.message
    );
  });
};

/**
 * Wraps a function with automatic performance logging
 * Measures execution time and logs errors automatically
 */
export async function withPerformanceLogging<T>(
  fn: () => Promise<T>,
  operation: string,
  context?: LogContext
): Promise<T> {
  const timer = new PerformanceTimer(operation, context);

  try {
    const result = await fn();
    timer.end(`${operation} completed successfully`);
    return result;
  } catch (error) {
    timer.endWithError(error as Error, `${operation} failed`);
    throw error;
  }
}

/**
 * Conditional logging based on log level configuration
 * Only executes logging logic if the level is enabled
 */
export const conditionalLog = (
  level: LogLevel,
  message: string,
  context?: LogContext
): void => {
  if (logger.isLevelEnabled(level)) {
    logger[level](context || {}, message);
  }
};
