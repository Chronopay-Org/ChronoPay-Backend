import { jest, beforeEach, expect, describe, it } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";

beforeEach(() => {
  delete process.env.FF_CREATE_SLOT;
  delete process.env.FF_CREATE_BOOKING_INTENT;
  delete process.env.FF_CHECKOUT;
});

// ─── Registry ───────────────────────────────────────────────────────────────

describe("feature flag registry", () => {
  it("exports known flags with correct defaults", async () => {
    const { FEATURE_FLAGS } = await import("../registry.js");
    expect(FEATURE_FLAGS.CREATE_SLOT.defaultEnabled).toBe(true);
    expect(FEATURE_FLAGS.CREATE_BOOKING_INTENT.defaultEnabled).toBe(false);
  });

  it("getAllGuardedFeatureRoutes returns CREATE_SLOT guarded routes", async () => {
    const { getAllGuardedFeatureRoutes } = await import("../registry.js");
    const routes = getAllGuardedFeatureRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes[0].flag).toBe("CREATE_SLOT");
  });

  it("isGuardedRouteRegistered matches known routes", async () => {
    const { isGuardedRouteRegistered } = await import("../registry.js");
    expect(isGuardedRouteRegistered("CREATE_SLOT", "POST", "/api/v1/slots")).toBe(true);
    expect(isGuardedRouteRegistered("CREATE_SLOT", "GET", "/api/v1/slots")).toBe(false);
  });
});

// ─── Service ────────────────────────────────────────────────────────────────

describe("resolveFeatureFlags", () => {
  it("uses defaults when no env vars are set", async () => {
    const { resolveFeatureFlags } = await import("../service.js");
    const state = resolveFeatureFlags({});
    expect(state.CREATE_SLOT).toBe(true);
    expect(state.CREATE_BOOKING_INTENT).toBe(false);
  });

  it("reads FF_CREATE_BOOKING_INTENT from env", async () => {
    const { resolveFeatureFlags } = await import("../service.js");
    const state = resolveFeatureFlags({ FF_CREATE_BOOKING_INTENT: "true" });
    expect(state.CREATE_BOOKING_INTENT).toBe(true);
  });

  it("accepts 1/0, true/false, on/off, yes/no values", async () => {
    const { resolveFeatureFlags } = await import("../service.js");
    const trues = resolveFeatureFlags({
      FF_CREATE_SLOT: "1",
      FF_CREATE_BOOKING_INTENT: "true",
    });
    expect(trues.CREATE_SLOT).toBe(true);
    expect(trues.CREATE_BOOKING_INTENT).toBe(true);

    const falses = resolveFeatureFlags({
      FF_CREATE_SLOT: "0",
      FF_CREATE_BOOKING_INTENT: "false",
    });
    expect(falses.CREATE_SLOT).toBe(false);
    expect(falses.CREATE_BOOKING_INTENT).toBe(false);

    const onOff = resolveFeatureFlags({
      FF_CREATE_SLOT: "on",
      FF_CREATE_BOOKING_INTENT: "off",
    });
    expect(onOff.CREATE_SLOT).toBe(true);
    expect(onOff.CREATE_BOOKING_INTENT).toBe(false);

    const yesNo = resolveFeatureFlags({
      FF_CREATE_SLOT: "yes",
      FF_CREATE_BOOKING_INTENT: "no",
    });
    expect(yesNo.CREATE_SLOT).toBe(true);
    expect(yesNo.CREATE_BOOKING_INTENT).toBe(false);
  });

  it("throws on malformed env value", async () => {
    const { resolveFeatureFlags } = await import("../service.js");
    expect(() =>
      resolveFeatureFlags({ FF_CREATE_SLOT: "maybe" }),
    ).toThrow("Invalid value for FF_CREATE_SLOT");
  });

  it("throws on empty string", async () => {
    const { resolveFeatureFlags } = await import("../service.js");
    expect(() =>
      resolveFeatureFlags({ FF_CREATE_SLOT: "" }),
    ).toThrow("Invalid value for FF_CREATE_SLOT");
  });
});

describe("isFeatureEnabled", () => {
  beforeEach(async () => {
    const { setFeatureFlagsFromEnv } = await import("../service.js");
    setFeatureFlagsFromEnv({});
  });

  it("returns default for CREATE_SLOT when no env set", async () => {
    const { isFeatureEnabled } = await import("../service.js");
    expect(isFeatureEnabled("CREATE_SLOT")).toBe(true);
  });

  it("returns default for CREATE_BOOKING_INTENT when no env set", async () => {
    const { isFeatureEnabled } = await import("../service.js");
    expect(isFeatureEnabled("CREATE_BOOKING_INTENT")).toBe(false);
  });

  it("returns false for disabled flag", async () => {
    const { setFeatureFlagsFromEnv, isFeatureEnabled } = await import("../service.js");
    setFeatureFlagsFromEnv({ FF_CREATE_SLOT: "false" });
    expect(isFeatureEnabled("CREATE_SLOT")).toBe(false);
  });
});

describe("getFeatureFlagsSnapshot", () => {
  it("returns a copy of the current state", async () => {
    const { setFeatureFlagsFromEnv, getFeatureFlagsSnapshot } = await import("../service.js");
    setFeatureFlagsFromEnv({ FF_CREATE_SLOT: "false" });
    const snap = getFeatureFlagsSnapshot();
    expect(snap.CREATE_SLOT).toBe(false);
    expect(snap).not.toBe(getFeatureFlagsSnapshot());
  });
});

describe("getFeatureFlagAccessor", () => {
  beforeEach(async () => {
    const { setFeatureFlagsFromEnv } = await import("../service.js");
    setFeatureFlagsFromEnv({});
  });

  it("isEnabled delegates to isFeatureEnabled", async () => {
    const { getFeatureFlagAccessor } = await import("../service.js");
    const accessor = getFeatureFlagAccessor();
    expect(accessor.isEnabled("CREATE_SLOT")).toBe(true);
    expect(accessor.isEnabled("CREATE_BOOKING_INTENT")).toBe(false);
  });

  it("list returns current snapshot", async () => {
    const { getFeatureFlagAccessor } = await import("../service.js");
    const list = getFeatureFlagAccessor().list();
    expect(list).toHaveProperty("CREATE_SLOT");
    expect(list).toHaveProperty("CREATE_BOOKING_INTENT");
  });
});

describe("setFeatureFlagsFromEnv", () => {
  it("re-initializes flags from a given env object", async () => {
    const { setFeatureFlagsFromEnv, isFeatureEnabled } = await import("../service.js");
    setFeatureFlagsFromEnv({ FF_CREATE_BOOKING_INTENT: "true" });
    expect(isFeatureEnabled("CREATE_BOOKING_INTENT")).toBe(true);
  });
});

// ─── Unknown flag ───────────────────────────────────────────────────────────

describe("unknown feature flag", () => {
  it("isFeatureEnabled throws for unknown flag", async () => {
    const { isFeatureEnabled } = await import("../service.js");
    expect(() => isFeatureEnabled("UNKNOWN_FLAG" as any)).toThrow("Unknown feature flag: UNKNOWN_FLAG");
  });
});

// ─── Middleware ─────────────────────────────────────────────────────────────

describe("featureFlagContextMiddleware", () => {
  it("attaches flags accessor to request", async () => {
    const { featureFlagContextMiddleware } = await import("../../middleware/featureFlags.js");
    const req = {} as Request;
    const res = {} as Response;
    const next = jest.fn() as NextFunction;

    featureFlagContextMiddleware(req, res, next);

    expect(req.flags).toBeDefined();
    expect(req.flags!.isEnabled("CREATE_SLOT")).toBe(true);
    expect(next).toHaveBeenCalled();
  });
});

describe("assertFeatureFlagGuardRegistration", () => {
  it("passes for registered route", async () => {
    const { assertFeatureFlagGuardRegistration } = await import("../../middleware/featureFlags.js");
    expect(() =>
      assertFeatureFlagGuardRegistration("CREATE_SLOT", "POST", "/api/v1/slots"),
    ).not.toThrow();
  });

  it("throws for unregistered route", async () => {
    const { assertFeatureFlagGuardRegistration } = await import("../../middleware/featureFlags.js");
    expect(() =>
      assertFeatureFlagGuardRegistration("CREATE_SLOT", "GET", "/api/v1/nonexistent"),
    ).toThrow("Missing feature-flag registry entry");
  });
});

describe("requireFeatureFlag", () => {
  beforeEach(async () => {
    const { setFeatureFlagsFromEnv } = await import("../service.js");
    setFeatureFlagsFromEnv({});
  });

  function mockReqRes(): { req: Request; res: Response; next: jest.Mock } {
    const req = { flags: undefined } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn() as NextFunction;
    return { req, res, next };
  }

  it("calls next when flag is enabled", async () => {
    const { setFeatureFlagsFromEnv } = await import("../service.js");
    setFeatureFlagsFromEnv({ FF_CREATE_SLOT: "true" });

    const { getFeatureFlagAccessor } = await import("../service.js");
    const { requireFeatureFlag } = await import("../../middleware/featureFlags.js");

    const { req, res, next } = mockReqRes();
    req.flags = getFeatureFlagAccessor();

    const middleware = requireFeatureFlag("CREATE_SLOT");
    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 503 when flag is disabled", async () => {
    const { setFeatureFlagsFromEnv } = await import("../service.js");
    setFeatureFlagsFromEnv({ FF_CREATE_SLOT: "false" });

    const { getFeatureFlagAccessor } = await import("../service.js");
    const { requireFeatureFlag } = await import("../../middleware/featureFlags.js");

    const { req, res, next } = mockReqRes();
    req.flags = getFeatureFlagAccessor();

    const middleware = requireFeatureFlag("CREATE_SLOT");
    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("returns 503 when flag is disabled by default", async () => {
    const { setFeatureFlagsFromEnv } = await import("../service.js");
    setFeatureFlagsFromEnv({});

    const { getFeatureFlagAccessor } = await import("../service.js");
    const { requireFeatureFlag } = await import("../../middleware/featureFlags.js");

    const { req, res, next } = mockReqRes();
    req.flags = getFeatureFlagAccessor();

    const middleware = requireFeatureFlag("CREATE_BOOKING_INTENT");
    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("returns 500 when flag evaluation throws", async () => {
    const { requireFeatureFlag } = await import("../../middleware/featureFlags.js");

    const { req, res, next } = mockReqRes();
    req.flags = { isEnabled: () => { throw new Error("oops"); }, list: () => ({}) } as any;

    const middleware = requireFeatureFlag("CREATE_SLOT");
    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("blocks when flag is disabled at runtime", async () => {
    const { setFeatureFlagsFromEnv, getFeatureFlagAccessor } = await import("../service.js");
    setFeatureFlagsFromEnv({});

    const { requireFeatureFlag } = await import("../../middleware/featureFlags.js");

    const { req, res, next } = mockReqRes();
    req.flags = getFeatureFlagAccessor();

    const middleware = requireFeatureFlag("CREATE_BOOKING_INTENT");
    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe("initializeFeatureFlagsFromEnv", () => {
  it("reinitializes flags from process.env", async () => {
    process.env.FF_CREATE_SLOT = "false";
    const { initializeFeatureFlagsFromEnv } = await import("../../middleware/featureFlags.js");
    const { isFeatureEnabled } = await import("../service.js");

    initializeFeatureFlagsFromEnv();
    expect(isFeatureEnabled("CREATE_SLOT")).toBe(false);
  });
});
