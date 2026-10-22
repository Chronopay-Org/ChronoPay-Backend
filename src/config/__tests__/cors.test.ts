import { afterEach, describe, expect, it } from "@jest/globals";
import { getCORSConfig, validateCORSConfig } from "../cors.js";

describe("CORS configuration", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each(["development", "production"])(
    "includes API request headers in the %s defaults",
    (nodeEnv) => {
      process.env = { ...originalEnv, NODE_ENV: nodeEnv };
      delete process.env.CORS_ALLOWED_HEADERS;

      expect(getCORSConfig().allowedHeaders).toEqual(
        expect.arrayContaining([
          "Idempotency-Key",
          "x-chronopay-mfa",
          "x-api-key",
          "x-chronopay-admin-token",
          "x-chronopay-user-id",
          "x-chronopay-role",
        ]),
      );
    },
  );

  it("allows CORS_ALLOWED_HEADERS to override the defaults", () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      CORS_ALLOWED_HEADERS: "Content-Type, X-Custom-Header",
    };

    expect(getCORSConfig().allowedHeaders).toEqual([
      "Content-Type",
      "X-Custom-Header",
    ]);
  });

  it("rejects wildcard-only and malformed configured origins", () => {
    const config = getCORSConfig();

    expect(() =>
      validateCORSConfig({ ...config, allowedOrigins: ["*"] }),
    ).toThrow("wildcard-only patterns are not allowed");
    expect(() =>
      validateCORSConfig({ ...config, allowedOrigins: ["not-a-url"] }),
    ).toThrow("Invalid origin URL: not-a-url");
  });
});
