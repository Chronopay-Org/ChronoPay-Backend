import request from "supertest";
import app from "../index.js";
import { FEATURE_FLAGS, getAllGuardedFeatureRoutes, setFeatureFlagsFromEnv } from "../flags/index.js";

type RequestMethod = "get" | "post" | "put" | "patch" | "delete";

function sendRequest(
  method: string,
  path: string,
  requestBody?: Record<string, unknown>,
) {
  const requester = request(app)[method.toLowerCase() as RequestMethod](path);
  return requestBody ? requester.send(requestBody) : requester;
}

describe("feature flag integration", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    setFeatureFlagsFromEnv(process.env);
  });

  it("enforces enabled/disabled behavior for every registered guarded route", async () => {
    const guardedRoutes = getAllGuardedFeatureRoutes();
    expect(guardedRoutes.length).toBeGreaterThan(0);

    for (const route of guardedRoutes) {
      const envVar = FEATURE_FLAGS[route.flag].envVar;
      const enabledEnv = { ...process.env, [envVar]: "true" };
      const disabledEnv = { ...process.env, [envVar]: "false" };

      setFeatureFlagsFromEnv(enabledEnv);
      const enabledResponse = await sendRequest(
        route.method,
        route.path,
        route.requestBody,
      );
      expect(enabledResponse.status).toBe(route.enabledExpectedStatus);

      setFeatureFlagsFromEnv(disabledEnv);
      const disabledResponse = await sendRequest(
        route.method,
        route.path,
        route.requestBody,
      );
      expect(disabledResponse.status).toBe(route.disabledResponse.status);
      expect(disabledResponse.body).toEqual({
        success: false,
        code: route.disabledResponse.code,
        error: route.disabledResponse.error,
      });
    }
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

  it("fails startup-time feature flag initialization on malformed values", () => {
    expect(() => setFeatureFlagsFromEnv({ ...process.env, FF_CREATE_SLOT: "enabled" })).toThrow(
      /Invalid value for FF_CREATE_SLOT/,
    );
  });
});
