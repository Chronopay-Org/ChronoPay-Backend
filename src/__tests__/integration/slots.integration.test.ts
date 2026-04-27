import { createIntegrationHarness } from "../helpers/integrationHarness.js";

describe("Slots integration harness", () => {
  const harness = createIntegrationHarness();

  it("returns health status for readiness checks", async () => {
    const res = await harness.request.get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      service: "chronopay-backend",
    });
  });

  it("creates a slot when payload and API key are valid", async () => {
    const res = await harness.authorizedPost("/api/v1/slots").send({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.slot.professional).toBe("alice");
  });

  it("rejects requests without API key", async () => {
    const res = await harness.request.post("/api/v1/slots").send({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing API key");
  });

  it("rejects requests with invalid API key", async () => {
    const res = await harness.request.post("/api/v1/slots").set("x-api-key", "bad").send({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Invalid API key");
  });

  it("returns validation error for missing required field", async () => {
    const res = await harness.authorizedPost("/api/v1/slots").send({
      startTime: 1000,
      endTime: 2000,
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns semantic validation errors for invalid times", async () => {
    const typeRes = await harness.authorizedPost("/api/v1/slots").send({
      professional: "alice",
      startTime: "1000",
      endTime: 2000,
    });

    expect(typeRes.status).toBe(422);
    expect(typeRes.body.error).toBe("startTime and endTime must be numbers");

    const rangeRes = await harness.authorizedPost("/api/v1/slots").send({
      professional: "alice",
      startTime: 2000,
      endTime: 2000,
    });

    expect(rangeRes.status).toBe(422);
    expect(rangeRes.body.error).toBe("endTime must be greater than startTime");
  });

  it("returns 400 on malformed JSON payload", async () => {
    const res = await harness.request
      .post("/api/v1/slots")
      .set("x-api-key", harness.apiKey)
      .set("content-type", "application/json")
      .send('{"professional":"alice"');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Malformed JSON payload");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await harness.request.get("/api/v1/unknown");

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns sanitized 500 response for unexpected failures", async () => {
    const res = await harness.request.get("/__test__/explode");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: "Internal server error",
    });
  });
});
