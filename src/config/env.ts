export type NodeEnv = "development" | "test" | "production";

export interface EnvConfig {
  nodeEnv: NodeEnv;
  port: number;
  redisUrl: string;
}

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const issues: string[] = [];

  const nodeEnv = parseNodeEnv(env.NODE_ENV, issues);
  const port = parsePort(env.PORT, issues);
  const redisUrl = parseRedisUrl(env.REDIS_URL, issues);

  const timeoutMs = parsePositiveInteger(env.REQUEST_TIMEOUT_MS, "REQUEST_TIMEOUT_MS", 30_000, issues);
  const rateLimitWindowMs = parsePositiveInteger(
    env.RATE_LIMIT_WINDOW_MS,
    "RATE_LIMIT_WINDOW_MS",
    15 * 60 * 1000,
    issues,
  );
  const rateLimitMax = parsePositiveInteger(env.RATE_LIMIT_MAX, "RATE_LIMIT_MAX", 100, issues);
  const trustProxy = parseBoolean(env.TRUST_PROXY, "TRUST_PROXY", false, issues);

  const webhookSecret = parseOptionalString(env.WEBHOOK_SECRET);
  const jwtIssuer = parseOptionalString(env.JWT_ISSUER);
  const jwtAudience = parseOptionalString(env.JWT_AUDIENCE);
  const corsAllowedOrigins = parseStringList(env.CORS_ALLOWED_ORIGINS);

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  return {
    nodeEnv,
    port,
    redisUrl,
  };
}

function parseNodeEnv(rawValue: string | undefined, issues: string[]): NodeEnv {
  if (rawValue === undefined) return "development";

  const value = rawValue.trim();
  const allowedValues: NodeEnv[] = ["development", "test", "production"];

  if (value.length === 0) {
    issues.push("NODE_ENV must be a non-empty value when provided.");
    return "development";
  }

  if (!allowedValues.includes(value as NodeEnv)) {
    issues.push("NODE_ENV must be one of: development, test, production.");
    return "development";
  }

  return value as NodeEnv;
}

function parsePort(rawValue: string | undefined, issues: string[]): number {
  return parseIntegerInRange(rawValue, "PORT", 3001, 1, 65535, issues);
}

function parsePositiveInteger(
  rawValue: string | undefined,
  key: string,
  defaultValue: number,
  issues: string[],
): number {
  return parseIntegerInRange(rawValue, key, defaultValue, 1, Number.MAX_SAFE_INTEGER, issues);
}

function parseIntegerInRange(
  rawValue: string | undefined,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
  issues: string[],
): number {
  if (rawValue === undefined) return defaultValue;

  const value = rawValue.trim();
  if (value.length === 0) {
    issues.push(`${key} must be a non-empty integer when provided.`);
    return defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    issues.push(`${key} must be a whole number between ${min} and ${max}.`);
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    issues.push(`${key} must be a whole number between ${min} and ${max}.`);
    return defaultValue;
  }

  return parsed;
}

function parseRedisUrl(rawValue: string | undefined, issues: string[]): string {
  if (rawValue === undefined) {
    issues.push("REDIS_URL is required.");
    return "redis://localhost:6379";
  }

  const value = rawValue.trim();

  if (value.length === 0) {
    issues.push("REDIS_URL must be a non-empty value.");
    return "redis://localhost:6379";
  }

  try {
    const url = new URL(value);
    const allowedSchemes = ["redis:", "rediss:"];

    if (!allowedSchemes.includes(url.protocol)) {
      issues.push("REDIS_URL must use one of the supported schemes: redis, rediss.");
      return "redis://localhost:6379";
    }

    if (!url.hostname) {
      issues.push("REDIS_URL must include a host.");
      return "redis://localhost:6379";
    }

    if (url.username || url.password) {
      issues.push("REDIS_URL must not contain embedded credentials.");
      return "redis://localhost:6379";
    }

    if (/\s/.test(value)) {
      issues.push("REDIS_URL must not contain whitespace.");
      return "redis://localhost:6379";
    }

    return value;
  } catch {
    issues.push("REDIS_URL must be a valid URL.");
    return "redis://localhost:6379";
  }
}
