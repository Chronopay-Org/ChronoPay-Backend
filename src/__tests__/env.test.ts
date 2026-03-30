import { EnvValidationError, loadEnvConfig } from "../config/env.js";

describe("environment config validation", () => {
  it("applies secure defaults for omitted optional variables", () => {
    expect(loadEnvConfig({})).toEqual({
      nodeEnv: "development",
      port: 3001,
    });
  });

  it("parses a fully valid configuration", () => {
    expect(
      loadEnvConfig({
        NODE_ENV: "production",
        PORT: "8080",
      }),
    ).toEqual({
      nodeEnv: "production",
      port: 8080,
    });
  });

  it("rejects unsupported NODE_ENV values", () => {
    expect(() =>
      loadEnvConfig({
        NODE_ENV: "prod",
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
      }),
    ).toThrow(
      new EnvValidationError([
        "NODE_ENV must be a non-empty value when provided.",
        "PORT must be a non-empty integer when provided.",
      ]),
    );
  });

  it("does not leak raw values in validation errors", () => {
    const badSecretLikeValue = "very-sensitive-looking-value";

    try {
      loadEnvConfig({
        NODE_ENV: badSecretLikeValue,
        PORT: "abc",
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
