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
});
