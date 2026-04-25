import { EnvValidationError, loadEnvConfig } from "../config/env.js";

const ACTIVE_KEY = Buffer.alloc(32, 1).toString("base64");
const PREVIOUS_KEY = Buffer.alloc(32, 2).toString("base64");

describe("environment config validation", () => {
  it("applies secure defaults for omitted optional variables when REDIS_URL is present", () => {
    expect(
      loadEnvConfig({
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toEqual({
      nodeEnv: "development",
      port: 3001,
      redisUrl: "redis://localhost:6379",
    });
  });

  it("parses a fully valid configuration", () => {
    expect(
      loadEnvConfig({
        NODE_ENV: "production",
        PORT: "8080",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toEqual({
      nodeEnv: "production",
      port: 8080,
      redisUrl: "redis://localhost:6379",
    });
  });

  it("rejects missing REDIS_URL", () => {
    expect(() =>
      loadEnvConfig({
        NODE_ENV: "production",
        PORT: "8080",
      }),
    ).toThrow(new EnvValidationError(["REDIS_URL is required."]));
  });

  it("rejects unsupported NODE_ENV values", () => {
    expect(() =>
      loadEnvConfig({
        NODE_ENV: "prod",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow(
      new EnvValidationError(["NODE_ENV must be one of: development, test, production."]),
    );
  });

  it("rejects invalid port values and aggregates multiple failures", () => {
    expect(() =>
      loadEnvConfig({
        NODE_ENV: "invalid",
        PORT: "70000",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow(
      new EnvValidationError([
        "NODE_ENV must be one of: development, test, production.",
        "PORT must be a whole number between 1 and 65535.",
      ]),
    );
  });

  it("rejects whitespace-only values", () => {
    expect(() =>
      loadEnvConfig({
        NODE_ENV: "   ",
        PORT: "   ",
        REDIS_URL: "   ",
      }),
    ).toThrow(
      new EnvValidationError([
        "NODE_ENV must be a non-empty value when provided.",
        "PORT must be a non-empty integer when provided.",
        "REDIS_URL must be a non-empty value.",
      ]),
    );
  });

  it("rejects invalid REDIS_URL values", () => {
    expect(() =>
      loadEnvConfig({
        NODE_ENV: "production",
        PORT: "8080",
        REDIS_URL: "ftp://example.com",
      }),
    ).toThrow(
      new EnvValidationError([
        "REDIS_URL must use one of the supported schemes: redis, rediss.",
      ]),
    );
  });

  it("rejects REDIS_URL with embedded credentials", () => {
    expect(() =>
      loadEnvConfig({
        NODE_ENV: "production",
        PORT: "8080",
        REDIS_URL: "redis://user:pass@localhost:6379",
      }),
    ).toThrow(
      new EnvValidationError([
        "REDIS_URL must not contain embedded credentials.",
      ]),
    );
  });

  it("does not leak raw values in validation errors", () => {
    const badSecretLikeValue = "very-sensitive-looking-value";

    try {
      loadEnvConfig({
        NODE_ENV: badSecretLikeValue,
        PORT: "abc",
        REDIS_URL: "redis://localhost:6379",
      });
      throw new Error("expected config validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain("NODE_ENV");
      expect((error as Error).message).toContain("PORT");
      expect((error as Error).message).not.toContain(badSecretLikeValue);
    }
  });

  it("rejects incomplete idempotency encryption config when enabled", () => {
    expect(() =>
      loadEnvConfig({
        IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED: "true",
      }),
    ).toThrow(
      new EnvValidationError([
        "IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY_ID is required when IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED=true.",
        "IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY is required when IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED=true.",
      ]),
    );
  });

  it("rejects invalid encryption flags and malformed keys", () => {
    expect(() =>
      loadEnvConfig({
        IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED: "maybe",
        IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY: "not-base64",
      }),
    ).toThrow(
      new EnvValidationError([
        "IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED must be either 'true' or 'false' when provided.",
      ]),
    );
  });

  it("rejects invalid key ids, malformed previous key entries, and duplicate ids", () => {
    expect(() =>
      loadEnvConfig({
        IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED: "true",
        IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY_ID: "bad key id",
        IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY: ACTIVE_KEY,
        IDEMPOTENCY_REDIS_ENCRYPTION_PREVIOUS_KEYS: [
          `current:${PREVIOUS_KEY}`,
          `current:${PREVIOUS_KEY}`,
          "malformed-entry",
        ].join(","),
      }),
    ).toThrow(
      new EnvValidationError([
        "IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY_ID must contain only letters, numbers, dots, underscores, or hyphens.",
        "IDEMPOTENCY_REDIS_ENCRYPTION_PREVIOUS_KEYS must not contain duplicate key ids.",
        "IDEMPOTENCY_REDIS_ENCRYPTION_PREVIOUS_KEYS entries must use the format key-id:base64-key.",
      ]),
    );
  });

  it("rejects empty and wrong-length encryption keys", () => {
    expect(() =>
      loadEnvConfig({
        IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED: "true",
        IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY_ID: "current",
        IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY: "   ",
      }),
    ).toThrow(
      new EnvValidationError([
        "IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY must be a non-empty base64 string when provided.",
      ]),
    );

    expect(() =>
      loadEnvConfig({
        IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED: "true",
        IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY_ID: "current",
        IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY: Buffer.alloc(16, 1).toString("base64"),
      }),
    ).toThrow(
      new EnvValidationError([
        "IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY must decode to exactly 32 bytes of base64 data.",
      ]),
    );
  });

  it("rejects previous keys that repeat the active key id", () => {
    expect(() =>
      loadEnvConfig({
        IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED: "true",
        IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY_ID: "current",
        IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY: ACTIVE_KEY,
        IDEMPOTENCY_REDIS_ENCRYPTION_PREVIOUS_KEYS: `current:${PREVIOUS_KEY}`,
      }),
    ).toThrow(
      new EnvValidationError([
        "IDEMPOTENCY_REDIS_ENCRYPTION_PREVIOUS_KEYS must not repeat IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY_ID.",
      ]),
    );
  });
});
