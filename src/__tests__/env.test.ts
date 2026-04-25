import { EnvValidationError, loadEnvConfig } from "../config/env.js";

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
});
