import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  buildRoleHierarchy,
  getEffectiveRoles,
  isKnownRole,
  requireRole,
  roleSatisfies,
  roles,
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

function appWithRoleListDeclaration(requiredRoles: string[]) {
  const app = express();
  app.get("/declared-route", requireRole(requiredRoles), (_req, res) => {
    res.json({ success: true });
  });
  return app;
}

describe("RBAC role hierarchy", () => {
  let auditSpy: jest.SpiedFunction<typeof defaultAuditLogger.log>;

  beforeEach(() => {
    auditSpy = jest.spyOn(defaultAuditLogger, "log").mockResolvedValue(undefined);
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
    app.get("/support-action", requireAuthenticatedActor(["support"]), (_req, res) =>
      res.json({ success: true }),
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
    app.get("/customer-action", requireAuthenticatedActor(["customer"]), (_req, res) =>
      res.json({ success: true }),
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

  it("returns 401 with an RBAC_MISSING audit when the role header is absent", async () => {
    const res = await request(appWithRoleDeclaration("support")).get("/declared-route").expect(401);

    expect(res.body).toMatchObject({
      success: false,
      code: "AUTHENTICATION_REQUIRED",
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0][0]).toMatchObject({
      action: "RBAC_MISSING",
      resource: "/declared-route",
      status: 401,
    });
  });

  it("returns 400 with an RBAC_INVALID_ROLE audit for an unknown role header", async () => {
    const res = await request(appWithRoleDeclaration("support"))
      .get("/declared-route")
      .set("x-user-role", "root")
      .expect(400);

    expect(res.body).toMatchObject({
      success: false,
      code: "BAD_REQUEST",
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0][0]).toMatchObject({
      action: "RBAC_INVALID_ROLE",
      status: 400,
    });
  });

  it("accepts any role in a multi-role declaration through the hierarchy", async () => {
    await request(appWithRoleListDeclaration(["support", "auditor"]))
      .get("/declared-route")
      .set("x-user-role", "support")
      .expect(200);

    await request(appWithRoleListDeclaration(["support", "auditor"]))
      .get("/declared-route")
      .set("x-user-role", "admin")
      .expect(200);

    await request(appWithRoleListDeclaration(["support", "auditor"]))
      .get("/declared-route")
      .set("x-user-role", "customer")
      .expect(403);
  });

  it("resolves the supplier role used by discount-curve routes", async () => {
    expect(isKnownRole("supplier")).toBe(true);

    await request(appWithRoleListDeclaration(["supplier", "admin"]))
      .get("/declared-route")
      .set("x-user-role", "supplier")
      .expect(200);

    await request(appWithRoleListDeclaration(["supplier", "admin"]))
      .get("/declared-route")
      .set("x-user-role", "admin")
      .expect(200);

    await request(appWithRoleListDeclaration(["supplier", "admin"]))
      .get("/declared-route")
      .set("x-user-role", "customer")
      .expect(403);
  });

  it("exposes the role catalog through isKnownRole, getEffectiveRoles and roles", () => {
    expect(isKnownRole("admin")).toBe(true);
    expect(isKnownRole("support")).toBe(true);
    expect(isKnownRole("auditor")).toBe(true);
    expect(isKnownRole("professional")).toBe(true);
    expect(isKnownRole("supplier")).toBe(true);
    expect(isKnownRole("customer")).toBe(true);
    expect(isKnownRole("superuser")).toBe(false);
    expect(isKnownRole("")).toBe(false);

    expect([...getEffectiveRoles("admin")].sort()).toEqual([
      "admin",
      "auditor",
      "customer",
      "professional",
      "support",
    ]);
    expect([...getEffectiveRoles("unknown")]).toEqual([]);

    expect(roles.admin).toBe("admin");
    expect(roles.supplier).toBe("supplier");
  });

  it("rejects an empty role declaration at setup time", () => {
    expect(() => requireRole([])).toThrow(/at least one required role/);
    expect(() => requireRole([""])).toThrow(/at least one required role/);
    expect(() => requireRole("   ")).toThrow(/at least one required role/);
  });

  it("rejects declarations that mix a known and an unknown role", () => {
    expect(() => requireRole(["admin", "superuser"])).toThrow(/unknown role superuser/);
  });

  it("normalizes declared roles case-insensitively and deduplicates", async () => {
    expect(() => requireRole(["ADMIN", "support", "admin"])).not.toThrow();

    await request(appWithRoleListDeclaration(["SUPPORT"]))
      .get("/declared-route")
      .set("x-user-role", "admin")
      .expect(200);
  });

  it("denies access without crashing when the audit logger rejects", async () => {
    auditSpy.mockRejectedValue(new Error("audit backend down"));

    const res = await request(appWithRoleDeclaration("support"))
      .get("/declared-route")
      .set("x-user-role", "auditor")
      .expect(403);

    expect(res.body).toMatchObject({
      success: false,
      code: "INSUFFICIENT_PERMISSIONS",
    });
  });

  it("returns 500 when the middleware catches an unexpected failure", () => {
    const middleware = requireRole(["admin"]);
    const req = {
      header: () => {
        throw new Error("boom");
      },
    };
    const res = {
      status: (s: number) => ({ json: (j: unknown) => ({ s, j }) }),
    };
    const result = middleware(req as any, res as any, () => {
      throw new Error("next should not be called");
    });
    expect(result.s).toBe(500);
  });

  it("fails startup validation for a missing roles object", () => {
    expect(() => buildRoleHierarchy({} as any)).toThrow(/must define a roles object/);
    expect(() => buildRoleHierarchy(null as any)).toThrow(/must define a roles object/);
  });

  it("fails startup validation for an empty role name", () => {
    expect(() =>
      buildRoleHierarchy({
        roles: { "": ["admin"], admin: [] } as any,
      }),
    ).toThrow(/empty role name/);
  });

  it("fails startup validation when implications are not an array", () => {
    expect(() =>
      buildRoleHierarchy({
        roles: { admin: "support" as any },
      }),
    ).toThrow(/must list implied roles/);
  });

  it("fails startup validation for an unknown implied role", () => {
    expect(() =>
      buildRoleHierarchy({
        roles: { admin: ["ghost"], ghost: [] },
      }),
    ).not.toThrow();

    expect(() =>
      buildRoleHierarchy({
        roles: { admin: ["ghost"] },
      }),
    ).toThrow(/implies unknown role ghost/);
  });

  it("resolves transitive implications across a shared subtree", () => {
    const hierarchy = buildRoleHierarchy({
      roles: {
        admin: ["support", "professional"],
        support: ["auditor"],
        professional: ["auditor"],
        auditor: [],
      },
    });

    expect([...(hierarchy.effectiveRolesByRole.get("admin") ?? [])].sort()).toEqual([
      "admin",
      "auditor",
      "professional",
      "support",
    ]);
  });

  it("freezes the built hierarchy so shared state cannot be mutated", () => {
    const hierarchy = buildRoleHierarchy({
      roles: { admin: ["support"], support: [], auditor: [] },
    });

    expect(hierarchy.roles.size).toBe(3);
    expect(hierarchy.effectiveRolesByRole.size).toBe(3);

    expect(() => (hierarchy.roles as Set<string>).add("hacker")).toThrow();
    expect(() =>
      (hierarchy.effectiveRolesByRole.get("admin") as Set<string>).add("hacker"),
    ).toThrow();
    expect(() =>
      (hierarchy.effectiveRolesByRole as Map<string, unknown>).set("hacker", new Set()),
    ).toThrow();
  });

  it("falls back to the socket address for audit events when req.ip is absent", async () => {
    const middleware = requireRole(["support"]);
    const req = {
      header: (name: string) => (name === "x-user-role" ? "auditor" : undefined),
      ip: undefined,
      socket: { remoteAddress: "10.0.0.7" },
      originalUrl: "/declared-route",
      method: "GET",
    };
    const res = {
      status: (s: number) => ({ json: (j: unknown) => ({ s, j }) }),
    };

    middleware(req as any, res as any, () => {});

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RBAC_FORBIDDEN",
        actorIp: "10.0.0.7",
        status: 403,
      }),
    );
  });

  it("handles audit events when both req.ip and req.socket are absent", async () => {
    const middleware = requireRole(["support"]);
    const req = {
      header: (name: string) => (name === "x-user-role" ? "auditor" : undefined),
      ip: undefined,
      socket: undefined,
      originalUrl: "/declared-route",
      method: "GET",
    };
    const res = {
      status: (s: number) => ({ json: (j: unknown) => ({ s, j }) }),
    };

    middleware(req as any, res as any, () => {});

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RBAC_FORBIDDEN",
        actorIp: undefined,
        status: 403,
      }),
    );
  });
});
