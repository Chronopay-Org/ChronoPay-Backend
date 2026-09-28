import { jest } from "@jest/globals";
import express, { type Request } from "express";
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

function makeReq(overrides: Record<string, any> = {}): Request {
  return {
    header: (name: string) => overrides.header?.[name] ?? undefined,
    ip: overrides.ip ?? undefined,
    socket: overrides.socket ?? undefined,
    originalUrl: overrides.originalUrl ?? "/admin-action",
    method: overrides.method ?? "GET",
    requestId: overrides.requestId ?? undefined,
    id: overrides.id ?? undefined,
  } as Request;
}

function makeRes(): any {
  const statuses: Record<number, { json: (j: unknown) => unknown }> = {};
  return {
    status: (s: number) => {
      if (!statuses[s]) statuses[s] = { json: (j: unknown) => ({ ...(j as object), _status: s }) };
      return statuses[s];
    },
    _statuses: statuses,
  };
}

describe("requireAdminToken", () => {
  let auditSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    auditSpy = jest.spyOn(defaultAuditLogger!, "log").mockResolvedValue(undefined);
  });

  afterEach(() => {
    auditSpy.mockRestore();
    delete process.env.CHRONOPAY_ADMIN_TOKEN;
  });

  describe("success path", () => {
    it("lets a request through with the configured token", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const res = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .expect(200);

      expect(res.body).toEqual({ success: true });
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("calls next() without arguments on successful authorization", () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;
      const next = jest.fn();
      const req = makeReq({
        header: { "x-chronopay-admin-token": ADMIN_TOKEN },
        ip: undefined,
        socket: undefined,
        originalUrl: "/admin-action",
        method: "GET",
      });
      const res = makeRes();

      requireAdminToken(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("preserves the existing public contract for the response envelope", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const res = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .expect(200);

      expect(res.body).toMatchObject({ success: true });
      expect(res.body).not.toHaveProperty("code");
    });
  });

  describe("unauthorized: missing or empty token header", () => {
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

    it("returns 401 when the token header is an empty string", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const res = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", "")
        .expect(401);

      expect(res.body).toMatchObject({
        success: false,
        code: "UNAUTHORIZED",
      });
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0][0].action).toBe("AUTHZ_MISSING");
      expect(auditSpy.mock.calls[0][0].status).toBe(401);
    });

    it("returns 401 when the token header is a whitespace-only string", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const res = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", "   ")
        .expect(401);

      expect(res.body).toMatchObject({
        success: false,
        code: "UNAUTHORIZED",
      });
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0][0].action).toBe("AUTHZ_MISSING");
    });
  });

  describe("forbidden: invalid token", () => {
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
      expect(JSON.stringify(auditSpy.mock.calls[0][0])).not.toContain("attacker-token");
    });

    it("enforces case-sensitive token comparison", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const res = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", "TEST-ADMIN-TOKEN")
        .expect(403);

      expect(res.body).toMatchObject({
        success: false,
        code: "FORBIDDEN",
      });
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0][0].action).toBe("AUTHZ_FORBIDDEN");
    });

    it("returns 403 with a token containing special characters", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const specialToken = "!@#$%^&*()_+-=[]{}|;:,.<>?";
      const res = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", specialToken)
        .expect(403);

      expect(res.body).toMatchObject({
        success: false,
        code: "FORBIDDEN",
      });
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0][0].action).toBe("AUTHZ_FORBIDDEN");
      expect(JSON.stringify(auditSpy.mock.calls[0][0])).not.toContain(specialToken);
    });
  });

  describe("configuration error: token not configured", () => {
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

    it("returns 503 even when a token header is provided but no token is configured", async () => {
      delete process.env.CHRONOPAY_ADMIN_TOKEN;

      const res = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", "some-token")
        .expect(503);

      expect(res.body).toMatchObject({
        success: false,
        code: "CONFIGURATION_ERROR",
      });
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0][0].action).toBe("AUTHZ_UNCONFIGURED");
      expect(auditSpy.mock.calls[0][0].status).toBe(503);
    });

    it("returns 503 when the configured token is an empty string", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = "";

      const res = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", "any-token")
        .expect(503);

      expect(res.body).toMatchObject({
        success: false,
        code: "CONFIGURATION_ERROR",
      });
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0][0].action).toBe("AUTHZ_UNCONFIGURED");
    });
  });

  describe("audit behavior", () => {
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

    it("audit logger rejection does not crash on AUTHZ_MISSING path", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;
      auditSpy.mockRejectedValue(new Error("audit backend down"));

      const res = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .expect(401);

      expect(res.body).toMatchObject({
        success: false,
        code: "UNAUTHORIZED",
      });
    });

    it("audit logger rejection does not crash on AUTHZ_UNCONFIGURED path", async () => {
      delete process.env.CHRONOPAY_ADMIN_TOKEN;
      auditSpy.mockRejectedValue(new Error("audit backend down"));

      const res = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", "any-token")
        .expect(503);

      expect(res.body).toMatchObject({
        success: false,
        code: "CONFIGURATION_ERROR",
      });
    });

    it("falls back to the socket address for audit events when req.ip is absent", () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const req = makeReq({
        header: { "x-chronopay-admin-token": "wrong-token" },
        ip: undefined,
        socket: { remoteAddress: "10.0.0.11" },
        originalUrl: "/admin-action",
        method: "GET",
      });
      const res = makeRes();

      requireAdminToken(req, res, () => {});

      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTHZ_FORBIDDEN",
          actorIp: "10.0.0.11",
          status: 403,
        }),
      );
    });

    it("uses req.ip directly when it is present", () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const req = makeReq({
        header: { "x-chronopay-admin-token": "wrong-token" },
        ip: "192.168.1.1",
        socket: { remoteAddress: "10.0.0.11" },
        originalUrl: "/admin-action",
        method: "GET",
      });
      const res = makeRes();

      requireAdminToken(req, res, () => {});

      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTHZ_FORBIDDEN",
          actorIp: "192.168.1.1",
          status: 403,
        }),
      );
    });

    it("never includes the raw token value in the audit event", () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;
      const attackerToken = "super-secret-token";

      const req = makeReq({
        header: { "x-chronopay-admin-token": attackerToken },
        ip: undefined,
        socket: { remoteAddress: "10.0.0.1" },
        originalUrl: "/admin-action",
        method: "GET",
      });
      const res = makeRes();

      requireAdminToken(req, res, () => {});

      const auditCall = auditSpy.mock.calls[0][0];
      const auditJson = JSON.stringify(auditCall);
      expect(auditJson).not.toContain(attackerToken);
      expect(auditCall.action).toBe("AUTHZ_FORBIDDEN");
    });

    it("audit event includes method and resource correctly", () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const req = makeReq({
        header: { "x-chronopay-admin-token": "wrong-token" },
        ip: undefined,
        socket: undefined,
        originalUrl: "/admin/settings",
        method: "POST",
      });
      const res = makeRes();

      requireAdminToken(req, res, () => {});

      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTHZ_FORBIDDEN",
          resource: "/admin/settings",
          metadata: { method: "POST" },
        }),
      );
    });

    it("audit event handles missing socket gracefully", () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const req = makeReq({
        header: { "x-chronopay-admin-token": "wrong-token" },
        ip: undefined,
        socket: undefined,
        originalUrl: "/admin-action",
        method: "GET",
      });
      const res = makeRes();

      expect(() => requireAdminToken(req, res, () => {})).not.toThrow();
    });

    it("audit event records undefined actorIp when both req.ip and socket.remoteAddress are absent", () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const req = makeReq({
        header: { "x-chronopay-admin-token": "wrong-token" },
        ip: undefined,
        socket: undefined,
        originalUrl: "/admin-action",
        method: "GET",
      });
      const res = makeRes();

      requireAdminToken(req, res, () => {});

      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "AUTHZ_FORBIDDEN",
          actorIp: undefined,
          status: 403,
        }),
      );
    });
  });

  describe("state transitions", () => {
    it("transitions from configured to unconfigured when env var is removed", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const res1 = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .expect(200);
      expect(res1.body).toEqual({ success: true });
      expect(auditSpy).not.toHaveBeenCalled();

      auditSpy.mockClear();
      delete process.env.CHRONOPAY_ADMIN_TOKEN;

      const res2 = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .expect(503);
      expect(res2.body).toMatchObject({ success: false, code: "CONFIGURATION_ERROR" });
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0][0].action).toBe("AUTHZ_UNCONFIGURED");
    });

    it("transitions from missing header to valid token", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const res1 = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .expect(401);
      expect(res1.body).toMatchObject({ success: false, code: "UNAUTHORIZED" });
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0][0].action).toBe("AUTHZ_MISSING");

      auditSpy.mockClear();

      const res2 = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .expect(200);
      expect(res2.body).toEqual({ success: true });
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("transitions from wrong token to correct token", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const res1 = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", "wrong-token")
        .expect(403);
      expect(res1.body).toMatchObject({ success: false, code: "FORBIDDEN" });

      auditSpy.mockClear();

      const res2 = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .expect(200);
      expect(res2.body).toEqual({ success: true });
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("handles multiple sequential requests with changing tokens deterministically", () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const cases = [
        { token: "wrong-1", expectCalled: true, expectedAction: "AUTHZ_FORBIDDEN", expectedStatus: 403 },
        { token: ADMIN_TOKEN, expectCalled: false, expectedAction: undefined, expectedStatus: undefined },
        { token: "wrong-2", expectCalled: true, expectedAction: "AUTHZ_FORBIDDEN", expectedStatus: 403 },
        { token: "", expectCalled: true, expectedAction: "AUTHZ_MISSING", expectedStatus: 401 },
        { token: ADMIN_TOKEN, expectCalled: false, expectedAction: undefined, expectedStatus: undefined },
      ];

      for (const c of cases) {
        auditSpy.mockClear();
        const req = makeReq({
          header: c.token !== "" ? { "x-chronopay-admin-token": c.token } : {},
          ip: undefined,
          socket: { remoteAddress: "10.0.0.1" },
          originalUrl: "/admin-action",
          method: "GET",
        });
        const res = makeRes();
        const next = jest.fn();

        requireAdminToken(req, res, next);

        if (!c.expectCalled) {
          expect(next).toHaveBeenCalled();
          expect(auditSpy).not.toHaveBeenCalled();
        } else {
          expect(next).not.toHaveBeenCalled();
          expect(auditSpy).toHaveBeenCalledTimes(1);
          expect(auditSpy.mock.calls[0][0].action).toBe(c.expectedAction);
          expect(auditSpy.mock.calls[0][0].status).toBe(c.expectedStatus);
        }
      }
    });

    it("recovers from unconfigured back to configured state", async () => {
      delete process.env.CHRONOPAY_ADMIN_TOKEN;

      await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .expect(503);

      auditSpy.mockClear();
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const res = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .expect(200);
      expect(res.body).toEqual({ success: true });
      expect(auditSpy).not.toHaveBeenCalled();
    });
  });

  describe("deterministic error behavior", () => {
    it("always returns the same status code for the same error condition", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      for (let i = 0; i < 3; i++) {
        const res = await request(appWithAdminTokenRoute())
          .get("/admin-action")
          .expect(401);
        expect(res.body.code).toBe("UNAUTHORIZED");
      }
      expect(auditSpy).toHaveBeenCalledTimes(3);
    });

    it("always returns the same status code for unconfigured token condition", async () => {
      delete process.env.CHRONOPAY_ADMIN_TOKEN;

      for (let i = 0; i < 3; i++) {
        const res = await request(appWithAdminTokenRoute())
          .get("/admin-action")
          .expect(503);
        expect(res.body.code).toBe("CONFIGURATION_ERROR");
      }
      expect(auditSpy).toHaveBeenCalledTimes(3);
    });

    it("error messages are consistent across repeated calls", async () => {
      process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

      const res1 = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", "wrong-token-1")
        .expect(403);

      auditSpy.mockClear();

      const res2 = await request(appWithAdminTokenRoute())
        .get("/admin-action")
        .set("x-chronopay-admin-token", "wrong-token-2")
        .expect(403);

      expect(res1.body.code).toBe(res2.body.code);
    });
  });
});
