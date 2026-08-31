import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { requireAdminToken } from "../middleware/authorization.js";
import { defaultAuditLogger } from "../services/auditLogger.js";

const ADMIN_TOKEN = "test-admin-token";

function appWithAdminTokenRoute() {
  const app = express();
  app.get("/admin-action", requireAdminToken, (_req, res) => {
    res.json({ success: true });
  });
  return app;
}

describe("requireAdminToken", () => {
  let auditSpy: jest.SpiedFunction<typeof defaultAuditLogger.log>;

  beforeEach(() => {
    auditSpy = jest.spyOn(defaultAuditLogger, "log").mockResolvedValue(undefined);
  });

  afterEach(() => {
    auditSpy.mockRestore();
    delete process.env.CHRONOPAY_ADMIN_TOKEN;
  });

  it("lets a request through with the configured token", async () => {
    process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

    const res = await request(appWithAdminTokenRoute())
      .get("/admin-action")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .expect(200);

    expect(res.body).toEqual({ success: true });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("returns 401 with an AUTHZ_MISSING audit when the token header is absent", async () => {
    process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

    const res = await request(appWithAdminTokenRoute()).get("/admin-action").expect(401);

    expect(res.body).toMatchObject({
      success: false,
      code: "UNAUTHORIZED",
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0][0]).toMatchObject({
      action: "AUTHZ_MISSING",
      resource: "/admin-action",
      status: 401,
    });
  });

  it("returns 403 with an AUTHZ_FORBIDDEN audit for a wrong token", async () => {
    process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

    const res = await request(appWithAdminTokenRoute())
      .get("/admin-action")
      .set("x-chronopay-admin-token", "attacker-token")
      .expect(403);

    expect(res.body).toMatchObject({
      success: false,
      code: "FORBIDDEN",
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0][0]).toMatchObject({
      action: "AUTHZ_FORBIDDEN",
      status: 403,
    });
    // The raw token value must never be written into the audit event.
    expect(JSON.stringify(auditSpy.mock.calls[0][0])).not.toContain("attacker-token");
  });

  it("returns 503 with an AUTHZ_UNCONFIGURED audit when no token is configured", async () => {
    delete process.env.CHRONOPAY_ADMIN_TOKEN;

    const res = await request(appWithAdminTokenRoute())
      .get("/admin-action")
      .set("x-chronopay-admin-token", "any-token")
      .expect(503);

    expect(res.body).toMatchObject({
      success: false,
      code: "CONFIGURATION_ERROR",
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0][0]).toMatchObject({
      action: "AUTHZ_UNCONFIGURED",
      status: 503,
    });
  });

  it("denies access without crashing when the audit logger rejects", async () => {
    process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;
    auditSpy.mockRejectedValue(new Error("audit backend down"));

    const res = await request(appWithAdminTokenRoute())
      .get("/admin-action")
      .set("x-chronopay-admin-token", "wrong-token")
      .expect(403);

    expect(res.body).toMatchObject({
      success: false,
      code: "FORBIDDEN",
    });
  });

  it("falls back to the socket address for audit events when req.ip is absent", () => {
    process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

    const middleware = requireAdminToken;
    const req = {
      header: (name: string) => (name === "x-chronopay-admin-token" ? "wrong-token" : undefined),
      ip: undefined,
      socket: { remoteAddress: "10.0.0.11" },
      originalUrl: "/admin-action",
      method: "GET",
    };
    const res = {
      status: (s: number) => ({ json: (j: unknown) => ({ s, j }) }),
    };

    middleware(req as any, res as any, () => {});

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUTHZ_FORBIDDEN",
        actorIp: "10.0.0.11",
        status: 403,
      }),
    );
  });
});
