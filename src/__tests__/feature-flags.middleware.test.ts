import type { NextFunction, Request, Response } from "express";
import { jest } from "@jest/globals";
import {
  featureFlagContextMiddleware,
  requireFeatureFlag,
} from "../middleware/featureFlags.js";
import { setFeatureFlagsFromEnv } from "../flags/index.js";

describe("feature flag middleware", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    setFeatureFlagsFromEnv(process.env);
  });

  it("attaches a feature flag accessor to request", () => {
    const req = {} as Request;
    const res = {} as Response;
    const next = jest.fn() as NextFunction;

    featureFlagContextMiddleware(req, res, next);

    expect(typeof req.flags.isEnabled).toBe("function");
    expect(typeof req.flags.list).toBe("function");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("allows request when flag is enabled", () => {
    setFeatureFlagsFromEnv({ ...process.env, FF_CREATE_SLOT: "true" });

    const req = {
      flags: {
        isEnabled: () => true,
        list: () => ({ CREATE_SLOT: true }),
      },
    } as unknown as Request;

    const status = jest.fn();
    const json = jest.fn();
    const res = { status, json } as unknown as Response;
    const next = jest.fn() as NextFunction;

    requireFeatureFlag("CREATE_SLOT")(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("returns 503 when a flag is disabled", () => {
    const req = {
      flags: {
        isEnabled: () => false,
        list: () => ({ CREATE_SLOT: false }),
      },
    } as unknown as Request;

    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const res = { status } as unknown as Response;
    const next = jest.fn() as NextFunction;

    requireFeatureFlag("CREATE_SLOT")(req, res, next);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      success: false,
      code: "FEATURE_DISABLED",
      error: "Feature CREATE_SLOT is currently disabled",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 500 when flag evaluation throws", () => {
    const req = {
      flags: {
        isEnabled: () => {
          throw new Error("boom");
        },
        list: () => ({ CREATE_SLOT: true }),
      },
    } as unknown as Request;

    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const res = { status } as unknown as Response;
    const next = jest.fn() as NextFunction;

    requireFeatureFlag("CREATE_SLOT")(req, res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      code: "FEATURE_FLAG_EVALUATION_ERROR",
      error: "Feature flag evaluation failed",
    });
    expect(next).not.toHaveBeenCalled();
  });
});
