import pino, { LoggerOptions } from "pino";

/**
 * Log levels following pino conventions:
 * - fatal: Service termination required
 * - error: Critical failures, external API errors, database errors
 * - warn: Recoverable issues, deprecated API usage
 * - info: Normal operations (default level)
 * - debug: Detailed diagnostic information
 * - trace: Fine-grained debugging
 */
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface LogContext {
  requestId?: string;
  userId?: string;
  service?: string;
  version?: string;
  environment?: string;
  [key: string]: unknown;
}

const isProduction = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

/**
 * Determines the appropriate log level based on environment
 * - Test: 'fatal' to suppress most logs during testing
 * - Production: 'info' for essential logs only
 * - Development: 'debug' for detailed diagnostics
 */
const getLogLevel = (): string => {
  if (isTest) return "fatal"; // Use fatal to suppress logs in tests
  if (isProduction) return "info";
  return "debug";
};

/**
 * Sanitizes sensitive data from log objects to prevent security leaks
 * Removes or masks fields like passwords, tokens, and secrets
 */
const sanitizeForLogging = (
  obj: Record<string, unknown>
): Record<string, unknown> => {
  const sensitiveFields = new Set([
    "password",
    "secret",
    "token",
    "apiKey",
    "api_key",
    "x-api-key",
    "authorization",
    "Authorization",
    "cookie",
    "session",
    "privateKey",
    "private_key",
  ]);

  const maskValue = (value: string): string =>
    value.length > 4
      ? `${value.substring(0, 2)}***${value.substring(value.length - 2)}`
      : "***";

  const sanitize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(sanitize);
    }

    if (input && typeof input === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (value === undefined) {
          continue;
        }

        if (sensitiveFields.has(key) && typeof value === "string") {
          result[key] = maskValue(value);
        } else {
          result[key] = sanitize(value);
        }
      }
      return result;
    }

    return input;
  };

  return sanitize(obj) as Record<string, unknown>;
};

/**
 * Creates the pino logger configuration with production-grade settings
 */
const createLoggerConfig = (): any => {
  const config: any = {
    level: getLogLevel(),
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      /**
       * Custom level formatter for better readability
       */
      level(label: string, number: number) {
        return { level: label.toUpperCase() };
      },
      /**
       * Bindings formatter to add default context to all logs
       */
      bindings(bindings: any) {
        return {
          ...bindings,
          service: process.env.SERVICE_NAME || "chronopay-backend",
          version: process.env.SERVICE_VERSION || "0.1.0",
          environment: process.env.NODE_ENV || "development",
          pid: process.pid,
          hostname: process.env.HOSTNAME || "localhost",
        };
      },
      /**
       * Object formatter to sanitize all logged objects
       */
      log(obj: any) {
        return sanitizeForLogging(obj);
      },
    },
    /**
     * Custom error serializer to properly capture error details
     */
    serializers: {
      error: (err: Error) => ({
        name: err.name,
        message: err.message,
        stack: err.stack,
        code: (err as NodeJS.ErrnoException).code,
        cause: (err as NodeJS.ErrnoException).cause,
      }),
    },
    /**
     * Redact option provides additional security by completely removing sensitive paths
     */
    redact: {
      paths: [
        "headers.authorization",
        "headers.cookie",
        "headers['x-api-key']",
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-api-key']",
        "body.password",
        "body.secret",
        "query.token",
      ],
      censor: "[REDACTED]",
    },
    /**
     * Ensure error causes are serialized
     */
    msgPrefix: "[ChronoPay] ",
  };

  /**
   * Development mode: pretty-printed logs for better developer experience
   * Production/Test mode: raw JSON for log aggregation systems
   */
  if (!isProduction && !isTest) {
    config.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    };
  }

  return config;
};

/**
 * Base logger instance with structured JSON output
 * All application logging should use this exported logger
 */
export const logger = pino(createLoggerConfig());

/**
 * Creates a child logger with additional context
 * Useful for module-specific logging or request-scoped logging
 *
 * @param context - Context object to attach to all logs from this child logger
 * @returns A new pino logger instance with the attached context
 */
export const createChildLogger = (context: LogContext) => {
  return logger.child(context);
};

/**
 * Utility function to log at a specific level with optional context
 * Wrapper around pino for consistent API across the codebase
 *
 * @param level - Log level to use
 * @param message - Log message
 * @param context - Optional context object
 */
export const log = (
  level: LogLevel,
  message: string,
  context?: LogContext
): void => {
  if (context) {
    logger[level](context, message);
  } else {
    logger[level](message);
  }
};

/**
 * Convenience methods for common logging scenarios
 */
export const logInfo = (message: string, context?: LogContext) =>
  log("info", message, context);
export const logError = (message: string, context?: LogContext) =>
  log("error", message, context);
export const logWarn = (message: string, context?: LogContext) =>
  log("warn", message, context);
export const logDebug = (message: string, context?: LogContext) =>
  log("debug", message, context);
