export type NodeEnv = "development" | "test" | "production";

export interface EnvConfig {
  nodeEnv: NodeEnv;
  port: number;
  redisUrl: string;
}

/**
 * Error raised when process environment variables fail validation.
 * The message is safe to surface during startup because it only contains
 * variable names and validation reasons, never raw values.
 */
export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/**
 * Parse and validate environment variables once at startup.
 *
 * @param env Raw environment map, usually process.env.
 * @returns Typed validated configuration for the application runtime.
 * @throws EnvValidationError When one or more variables are missing or invalid.
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const issues: string[] = [];
  const nodeEnv = parseNodeEnv(env.NODE_ENV, issues);
  const port = parsePort(env.PORT, issues);
  const redisUrl = parseRedisUrl(env.REDIS_URL, issues);

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
  if (rawValue === undefined) {
    return "development";
  }

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
  if (rawValue === undefined) {
    return 3001;
  }

  const value = rawValue.trim();
  if (value.length === 0) {
    issues.push("PORT must be a non-empty integer when provided.");
    return 3001;
  }

  if (!/^\d+$/.test(value)) {
    issues.push("PORT must be a whole number between 1 and 65535.");
    return 3001;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    issues.push("PORT must be a whole number between 1 and 65535.");
    return 3001;
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
