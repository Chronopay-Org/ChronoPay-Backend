// @ts-nocheck
import { describe, expect, it } from '@jest/globals';
import { validateTimeoutConfig, type TimeoutConfig } from './timeouts.js';

function validConfig(): TimeoutConfig {
  return {
    http: { defaultMs: 5_000, contractMs: 7_000, smsMs: 5_000, webhookMs: 4_000 },
    retry: { maxAttempts: 3, baseDelayMs: 200, maxTotalBudgetMs: 8_000 },
    queryBudget: { defaultMs: 30_000, routeOverrides: {} },
  };
}

describe('validateTimeoutConfig', () => {
  it('accepts a complete valid configuration and the minimum positive boundary', () => {
    validateTimeoutConfig(validConfig());
    const config = validConfig();
    config.http.defaultMs = 1;
    config.retry.baseDelayMs = 1;
    config.queryBudget.defaultMs = 1;
    config.queryBudget.routeOverrides = { '/api/v1/health': 1 };
    expect(() => validateTimeoutConfig(config)).not.toThrow();
  });

  it.each([
    ['http.defaultMs', (config: TimeoutConfig) => { config.http.defaultMs = 0; }],
    ['http.contractMs', (config: TimeoutConfig) => { config.http.contractMs = -1; }],
    ['retry.maxAttempts', (config: TimeoutConfig) => { config.retry.maxAttempts = 0; }],
    ['queryBudget.defaultMs', (config: TimeoutConfig) => { config.queryBudget.defaultMs = -1; }],
  ])('rejects non-positive %s values with a deterministic error', (name, mutate) => {
    const config = validConfig();
    mutate(config);
    expect(() => validateTimeoutConfig(config)).toThrow(
      `Timeout configuration error: ${name} must be positive, got ${name.includes('contract') || name.includes('query') ? -1 : 0}`
    );
  });

  it('rejects a non-positive route-specific query budget', () => {
    const config = validConfig();
    config.queryBudget.routeOverrides = { '/api/v1/admin': 0 };
    expect(() => validateTimeoutConfig(config)).toThrow(
      'Timeout configuration error: queryBudget.routeOverrides["/api/v1/admin"] must be positive, got 0'
    );
  });
});
