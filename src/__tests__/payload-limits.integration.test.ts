import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { createApp } from "../app.js";
import { setFeatureFlagsFromEnv } from "../flags/service.js";

const app = createApp({ enableContentNegotiation: false, enableDocs: false });

describe("application payload limits", () => {
  beforeAll(() => {
    process.env.FF_CHECKOUT = "true";
    process.env.FF_CREATE_BOOKING_INTENT = "true";
    setFeatureFlagsFromEnv(process.env);
  });

  afterAll(() => {
    delete process.env.FF_CHECKOUT;
    delete process.env.FF_CREATE_BOOKING_INTENT;
    setFeatureFlagsFromEnv(process.env);
  });

  it("rejects a 20kb checkout create body at its 16kb route limit", async () => {
    const response = await request(app)
      .post("/api/v1/checkout/sessions")
      .send({ data: "x".repeat(20_000) });

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      success: false,
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("maps the global JSON parser's 150kb rejection to 413", async () => {
    const response = await request(app)
      .post("/api/v1/checkout/sessions")
      .send({ data: "x".repeat(150_000) });

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      success: false,
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("rejects a 20kb booking intent body at its 16kb route limit", async () => {
    const response = await request(app)
      .post("/api/v1/booking-intents")
      .send({ data: "x".repeat(20_000) });

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      success: false,
      code: "PAYLOAD_TOO_LARGE",
    });
  });
});
