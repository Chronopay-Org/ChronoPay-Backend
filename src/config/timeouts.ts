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
  /** Default per-query statement_timeout in milliseconds. */
  queryBudget: {
    /** Global default budget applied when no route-specific budget is configured. */
    defaultMs: number;
    /** Per-route overrides. Key = Express route pattern (e.g. "/api/v1/admin/"). */
    routeOverrides: Record<string, number>;
  };
};

/**
 * Parse route override string like "/api/v1/admin/:*:60000,/api/v1/checkout:15000".
 * Returns a map of route pattern → budget in ms.
 */
function parseRouteOverrides(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  const overrides: Record<string, number> = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const lastColon = trimmed.lastIndexOf(":");
    if (lastColon === -1) continue;
    const route = trimmed.slice(0, lastColon);
    const ms = parseInt(trimmed.slice(lastColon + 1), 10);
    if (route && !isNaN(ms) && ms > 0) {
      overrides[route] = ms;
    }
  }
  return overrides;
}

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
  queryBudget: {
    defaultMs: getEnvInt("QUERY_BUDGET_DEFAULT_MS", 30000),
    routeOverrides: parseRouteOverrides(process.env.QUERY_BUDGET_ROUTE_OVERRIDES),
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
  checkPositive(config.queryBudget.defaultMs, "queryBudget.defaultMs");
  for (const [route, ms] of Object.entries(config.queryBudget.routeOverrides)) {
    if (ms <= 0) throw new Error(`Timeout configuration error: queryBudget.routeOverrides["${route}"] must be positive, got ${ms}`);
  }
}
