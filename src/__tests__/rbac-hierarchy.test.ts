import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  buildRoleHierarchy,
  requireRole,
  roleSatisfies,
} from "../middleware/rbac.js";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { defaultAuditLogger } from "../services/auditLogger.js";

function appWithRoleDeclaration(requiredRole: string) {
  const app = express();
  app.get("/declared-route", requireRole(requiredRole), (_req, res) => {
    res.json({ success: true });
  });
  return app;
}

describe("RBAC role hierarchy", () => {
  let auditSpy: jest.SpiedFunction<typeof defaultAuditLogger.log>;

  beforeEach(() => {
    auditSpy = jest
      .spyOn(defaultAuditLogger, "log")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    auditSpy.mockRestore();
  });

  it("allows an admin through a route that declares support", async () => {
    const res = await request(appWithRoleDeclaration("support"))
      .get("/declared-route")
      .set("x-user-role", "admin")
      .expect(200);

    expect(res.body).toEqual({ success: true });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("allows support through a support route and auditor through an auditor route", async () => {
    await request(appWithRoleDeclaration("support"))
      .get("/declared-route")
      .set("x-user-role", "support")
      .expect(200);

    await request(appWithRoleDeclaration("auditor"))
      .get("/declared-route")
      .set("x-user-role", "auditor")
      .expect(200);
  });

  it("denies auditor on a support route and emits a bounded audit event", async () => {
    const res = await request(appWithRoleDeclaration("support"))
      .get("/declared-route")
      .set("x-user-role", "auditor")
      .expect(403);

    expect(res.body).toMatchObject({
      success: false,
      code: "INSUFFICIENT_PERMISSIONS",
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0][0]).toMatchObject({
      action: "RBAC_FORBIDDEN",
      resource: "/declared-route",
      status: 403,
      metadata: {
        method: "GET",
        role: "auditor",
        requiredRoles: ["support"],
      },
    });
  });

  it("resolves transitive hierarchy implications", () => {
    expect(roleSatisfies("admin", "support")).toBe(true);
    expect(roleSatisfies("admin", "auditor")).toBe(true);
    expect(roleSatisfies("support", "auditor")).toBe(true);
    expect(roleSatisfies("auditor", "support")).toBe(false);
  });

  it("fails startup validation for cyclic role definitions", () => {
    expect(() =>
      buildRoleHierarchy({
        roles: {
          admin: ["support"],
          support: ["auditor"],
          auditor: ["admin"],
        },
      }),
    ).toThrow(/cyclic role definition/);
  });

  it("rejects route declarations for unknown roles", () => {
    expect(() => requireRole("superuser")).toThrow(/unknown role superuser/);
  });

  it("uses the same hierarchy for header-authenticated actors", async () => {
    const app = express();
    app.get(
      "/support-action",
      requireAuthenticatedActor(["support"]),
      (_req, res) => res.json({ success: true }),
    );

    await request(app)
      .get("/support-action")
      .set("x-chronopay-user-id", "admin-1")
      .set("x-chronopay-role", "admin")
      .expect(200);

    await request(app)
      .get("/support-action")
      .set("x-chronopay-user-id", "auditor-1")
      .set("x-chronopay-role", "auditor")
      .expect(403);

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RBAC_FORBIDDEN",
        status: 403,
      }),
    );
  });

  it("does not downgrade unknown header roles to customer", async () => {
    const app = express();
    app.get(
      "/customer-action",
      requireAuthenticatedActor(["customer"]),
      (_req, res) => res.json({ success: true }),
    );

    await request(app)
      .get("/customer-action")
      .set("x-chronopay-user-id", "user-1")
      .set("x-chronopay-role", "hacker")
      .expect(400);

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RBAC_INVALID_ROLE",
        status: 400,
      }),
    );
  });
});
