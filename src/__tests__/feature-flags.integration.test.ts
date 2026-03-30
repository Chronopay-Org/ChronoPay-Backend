import request from "supertest";
import app from "../index.js";
import { setFeatureFlagsFromEnv } from "../flags/index.js";

describe("feature flag integration", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    setFeatureFlagsFromEnv(process.env);
  });

  it("returns 201 for POST /api/v1/slots when enabled", async () => {
    setFeatureFlagsFromEnv({ ...process.env, FF_CREATE_SLOT: "true" });

    const res = await request(app).post("/api/v1/slots").send({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it("returns 503 for POST /api/v1/slots when disabled", async () => {
    setFeatureFlagsFromEnv({ ...process.env, FF_CREATE_SLOT: "false" });

    const res = await request(app).post("/api/v1/slots").send({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      code: "FEATURE_DISABLED",
      error: "Feature CREATE_SLOT is currently disabled",
    });
  });

  it("keeps GET /api/v1/slots available when feature is disabled", async () => {
    setFeatureFlagsFromEnv({ ...process.env, FF_CREATE_SLOT: "false" });

    const res = await request(app).get("/api/v1/slots");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.slots)).toBe(true);
  });

  it("still validates input when feature is enabled", async () => {
    setFeatureFlagsFromEnv({ ...process.env, FF_CREATE_SLOT: "true" });

    const res = await request(app).post("/api/v1/slots").send({
      startTime: 1000,
      endTime: 2000,
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Missing required field");
  });
});
