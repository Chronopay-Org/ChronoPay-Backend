import { captureOpenApiExample, mergeOpenApiExamples, clearCapturedOpenApiExamples } from "./openapiExamples.js";

describe("OpenAPI example capture", () => {
  beforeEach(() => clearCapturedOpenApiExamples());

  it("captures sanitized request and response examples", () => {
    const example = captureOpenApiExample({
      method: "POST",
      path: "/api/v1/checkout/sessions",
      requestBody: { email: "person@example.com", password: "secret", nested: { token: "abc123" } },
      responseBody: { success: true, checkoutUrl: "https://example.test/pay", user: { email: "person@example.com" } },
      statusCode: 201,
    });

    expect(example.request).toEqual(expect.objectContaining({ email: "[REDACTED_EMAIL]", password: "[REDACTED]" }));
    expect(example.response).toEqual(expect.objectContaining({ success: true }));
  });

  it("injects captured examples into the generated OpenAPI spec", () => {
    captureOpenApiExample({
      method: "GET",
      path: "/api/v1/checkout/sessions/123",
      responseBody: { success: true, session: { id: "123" } },
      statusCode: 200,
    });

    const spec = mergeOpenApiExamples({
      paths: {
        "/api/v1/checkout/sessions/{sessionId}": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {},
                },
              },
            },
          },
        },
      },
    });

    expect(spec.paths["/api/v1/checkout/sessions/{sessionId}"].get.responses["200"].content["application/json"].example).toEqual({
      success: true,
      session: { id: "123" },
    });
  });

  describe("failure and empty-result handling", () => {
    it("returns undefined for string or empty bodies during sanitization", () => {
      const example = captureOpenApiExample({
        method: "POST",
        path: "/api/v1/ping",
        requestBody: "plain text string",
        responseBody: null,
      });

      expect(example.request).toBeUndefined();
      expect(example.response).toBeUndefined();
    });

    it("returns a mapped object with a value property for non-object, non-string primitives", () => {
      const example = captureOpenApiExample({
        method: "POST",
        path: "/api/v1/primitive",
        requestBody: 12345,
        responseBody: true,
      });

      expect(example.request).toEqual({ value: 12345 });
      expect(example.response).toEqual({ value: true });
    });

    it("ignores captured examples that do not match any spec path", () => {
      captureOpenApiExample({
        method: "GET",
        path: "/api/v1/unknown",
        responseBody: { ok: true },
        statusCode: 200,
      });

      const spec = mergeOpenApiExamples({
        paths: {
          "/api/v1/known": {
            get: {
              responses: {
                "200": { content: {} },
              },
            },
          },
        },
      });

      expect(spec.paths["/api/v1/known"].get.responses["200"].content).toEqual({});
      expect(spec.paths["/api/v1/unknown"]).toBeUndefined();
    });

    it("returns undefined and ignores paths with mismatched segment lengths or unmatching literal segments", () => {
      // 5 segments vs 4 segments in spec
      captureOpenApiExample({
        method: "GET",
        path: "/api/v1/users/123/profile",
        responseBody: { ok: true },
        statusCode: 200,
      });

      // 4 segments but literal mismatch ("users" vs "admins")
      captureOpenApiExample({
        method: "GET",
        path: "/api/v1/users/123",
        responseBody: { ok: true },
        statusCode: 200,
      });

      const spec = mergeOpenApiExamples({
        paths: {
          "/api/v1/users/{userId}": {
            get: {
              responses: {
                "200": { content: {} },
              },
            },
          },
          "/api/v1/admins/{adminId}": {
            get: {
              responses: {
                "200": { content: {} },
              },
            },
          },
        },
      });

      // Neither example should be merged
      expect(spec.paths["/api/v1/users/{userId}"].get.responses["200"].content).toEqual({});
      expect(spec.paths["/api/v1/admins/{adminId}"].get.responses["200"].content).toEqual({});
    });
  });
});
