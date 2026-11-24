import { describe, expect, it } from "@jest/globals";
import { buildExportBaseUrl } from "../buildBaseUrl.js";

describe("buildExportBaseUrl", () => {
  it("returns the configured origin and strips path, query, and fragment", () => {
    expect(
      buildExportBaseUrl({
        NODE_ENV: "production",
        APP_URL: "https://exports.example.com:8443/api/v1?source=test#download",
      }),
    ).toBe("https://exports.example.com:8443");
  });

  it("uses the localhost fallback when APP_URL is unset outside production", () => {
    expect(buildExportBaseUrl({ NODE_ENV: "development" })).toBe("http://localhost:3001");
    expect(buildExportBaseUrl({ NODE_ENV: "test" })).toBe("http://localhost:3001");
    expect(buildExportBaseUrl({})).toBe("http://localhost:3001");
  });

  it("throws when APP_URL is missing in production", () => {
    expect(() => buildExportBaseUrl({ NODE_ENV: "production" })).toThrow(
      "APP_URL must be configured in production for export download URLs.",
    );
  });

  it("throws when APP_URL is invalid in production", () => {
    expect(() =>
      buildExportBaseUrl({ NODE_ENV: "production", APP_URL: "not-a-url" }),
    ).toThrow("APP_URL is set but is not a valid http(s) URL.");
  });

  it("falls back to localhost for an invalid APP_URL outside production", () => {
    expect(
      buildExportBaseUrl({ NODE_ENV: "development", APP_URL: "ftp://files.example.com" }),
    ).toBe("http://localhost:3001");
  });

  it.each([
    "javascript:alert(1)",
    "ftp://files.example.com",
    "https://user:password@example.com",
    "https://example.com/path with spaces",
    "https://example.com\\\\evil",
    "https://",
  ])("rejects an unsafe or malformed URL in production: %s", (APP_URL) => {
    expect(() => buildExportBaseUrl({ NODE_ENV: "production", APP_URL })).toThrow(
      "APP_URL is set but is not a valid http(s) URL.",
    );
  });

  it("accepts an uppercase HTTP scheme and returns a normalized origin", () => {
    expect(
      buildExportBaseUrl({ NODE_ENV: "production", APP_URL: "HTTPS://Example.COM/export/" }),
    ).toBe("https://example.com");
  });

  it("does not add a trailing slash to the returned origin", () => {
    expect(
      buildExportBaseUrl({ NODE_ENV: "production", APP_URL: "https://example.com/" }),
    ).toBe("https://example.com");
  });
});
