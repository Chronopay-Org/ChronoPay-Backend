import { describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";

import {
  assertFeatureFlagGuardRegistration,
  featureFlagContextMiddleware,
} from "../featureFlags.js";

describe("TenantAwareFeatureFlagAccessor failure handling", () => {
  it("accepts a registered guard regardless of HTTP method casing", () => {
    expect(() =>
      assertFeatureFlagGuardRegistration("CREATE_SLOT", "post", "/api/v1/slots"),
    ).not.toThrow();
  });

  it("throws the deterministic guard-registration error for an unregistered route", () => {
    expect(() =>
      assertFeatureFlagGuardRegistration("CREATE_SLOT", "get", "/api/v1/missing"),
    ).toThrow("Missing feature-flag registry entry for CREATE_SLOT guard on GET /api/v1/missing");
  });

  it.each([
    [
      "",
      "/api/v1/slots",
      "Missing feature-flag registry entry for CREATE_SLOT guard on  /api/v1/slots",
    ],
    ["POST", "", "Missing feature-flag registry entry for CREATE_SLOT guard on POST "],
  ])("rejects boundary method/path input %#", (method, path, expectedMessage) => {
    expect(() => assertFeatureFlagGuardRegistration("CREATE_SLOT", method, path)).toThrow(
      expectedMessage,
    );
  });

  it("attaches the tenant-aware accessor and continues on the normal path", () => {
    const req = {} as Request;
    const next = jest.fn() as NextFunction;

    featureFlagContextMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.flags).toEqual(
      expect.objectContaining({
        isEnabled: expect.any(Function),
        isEnabledForTenant: expect.any(Function),
      }),
    );
    expect(() =>
      req.flags!.isEnabledForTenant("CREATE_SLOT", "tenant-a", "bucket-a"),
    ).not.toThrow();
  });
});
