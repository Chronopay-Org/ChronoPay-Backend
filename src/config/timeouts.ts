/**
 * Timeout Configuration
 * 
 * Centralized configuration for all outbound call timeouts and retry policies.
 */

export type TimeoutConfig = {
  http: {
    defaultMs: number;
    contractMs: number;
    smsMs: number;
    webhookMs: number;
  };
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxTotalBudgetMs: number;
  };
};

const getEnvInt = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    console.warn(`Invalid value for ${key}: ${value}. Using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
};

export const timeoutConfig: TimeoutConfig = {
  http: {
    defaultMs: getEnvInt("TIMEOUT_HTTP_DEFAULT_MS", 5000),
    contractMs: getEnvInt("TIMEOUT_HTTP_CONTRACT_MS", 7000),
    smsMs: getEnvInt("TIMEOUT_HTTP_SMS_MS", 5000),
    webhookMs: getEnvInt("TIMEOUT_HTTP_WEBHOOK_MS", 4000),
  },
  retry: {
    maxAttempts: getEnvInt("RETRY_MAX_ATTEMPTS", 3),
    baseDelayMs: getEnvInt("RETRY_BASE_DELAY_MS", 200),
    maxTotalBudgetMs: getEnvInt("RETRY_MAX_TOTAL_BUDGET_MS", 8000),
  },
};

/**
 * Validates the timeout configuration on startup.
 * Throws an error if any values are non-positive.
 */
export function validateTimeoutConfig(config: TimeoutConfig = timeoutConfig): void {
  const checkPositive = (val: number, name: string) => {
    if (val <= 0) throw new Error(`Timeout configuration error: ${name} must be positive, got ${val}`);
  };

  checkPositive(config.http.defaultMs, "http.defaultMs");
  checkPositive(config.http.contractMs, "http.contractMs");
  checkPositive(config.http.smsMs, "http.smsMs");
  checkPositive(config.http.webhookMs, "http.webhookMs");
  checkPositive(config.retry.maxAttempts, "retry.maxAttempts");
  checkPositive(config.retry.baseDelayMs, "retry.baseDelayMs");
  checkPositive(config.retry.maxTotalBudgetMs, "retry.maxTotalBudgetMs");
}
