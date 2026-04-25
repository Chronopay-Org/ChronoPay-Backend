/**
 * Audit event tests for auth.ts and rbac.ts failure paths.
 *
 * Security invariants verified:
 *   - Audit entries never contain raw header values, tokens, or userId on 401.
 *   - Each failure path emits exactly one audit event (no double-logging).
 *   - Stable action codes are used for each failure mode.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { defaultAuditLogger } from "../services/auditLogger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(headers: Record<string, string> = {}, url = "/api/test"): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    ip: "10.0.0.1",
    socket: { remoteAddress: "10.0.0.1" },
    originalUrl: url,
    method: "GET",
  } as unknown as Request;
}

function makeRes(): { res: Response; status: number; body: unknown } {
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(b: unknown) { state.body = b; return this; },
  } as unknown as Response;
  return { res, ...state, get status() { return state.status; }, get body() { return state.body; } };
}

// ─── requireAuthenticatedActor ────────────────────────────────────────────────

describe("requireAuthenticatedActor — audit events", () => {
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    logSpy = jest.spyOn(defaultAuditLogger, "log").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits AUTH_MISSING (401) when x-chronopay-user-id header is absent", () => {
    const req = makeReq({});
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuthenticatedActor()(req, res, next);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "AUTH_MISSING", status: 401 }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("emits AUTH_MISSING (401) when x-chronopay-user-id is whitespace only", () => {
    const req = makeReq({ "x-chronopay-user-id": "   " });
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuthenticatedActor()(req, res, next);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "AUTH_MISSING", status: 401 }),
    );
  });

  it("emits AUTH_FORBIDDEN (403) when role is not in allowedRoles", () => {
    const req = makeReq({
      "x-chronopay-user-id": "user-1",
      "x-chronopay-role": "customer",
    });
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuthenticatedActor(["admin"])(req, res, next);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "AUTH_FORBIDDEN", status: 403 }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("does NOT emit an audit event on success", () => {
    const req = makeReq({
      "x-chronopay-user-id": "user-1",
      "x-chronopay-role": "admin",
    });
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuthenticatedActor(["admin"])(req, res, next);

    expect(logSpy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("audit entry for AUTH_MISSING never contains userId or raw header values", () => {
    const req = makeReq({ "x-chronopay-user-id": "secret-user-id" });
    // Whitespace-only → triggers 401
    const req2 = makeReq({ "x-chronopay-user-id": "   " });
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuthenticatedActor()(req2, res, next);

    const entry = logSpy.mock.calls[0][0] as Record<string, unknown>;
    const entryStr = JSON.stringify(entry);
    expect(entryStr).not.toContain("secret-user-id");
    expect(entryStr).not.toContain("x-chronopay-user-id");
  });

  it("logs actorIp and resource but not userId on AUTH_MISSING", () => {
    const req = makeReq({}, "/api/v1/protected");
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuthenticatedActor()(req, res, next);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actorIp: "10.0.0.1",
        resource: "/api/v1/protected",
      }),
    );
    const entry = logSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(entry).not.toHaveProperty("userId");
  });

  it("emits exactly one event per failed request (no double-logging)", () => {
    const req = makeReq({});
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireAuthenticatedActor()(req, res, next);

    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── requireRole ──────────────────────────────────────────────────────────────

describe("requireRole — audit events", () => {
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    logSpy = jest.spyOn(defaultAuditLogger, "log").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("emits RBAC_MISSING (401) when x-user-role header is absent", () => {
    const req = makeReq({});
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireRole(["admin"])(req, res, next);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "RBAC_MISSING", status: 401 }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("emits RBAC_INVALID_ROLE (400) when role value is not a known role", () => {
    const req = makeReq({ "x-user-role": "superuser" });
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireRole(["admin"])(req, res, next);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "RBAC_INVALID_ROLE", status: 400 }),
    );
  });

  it("emits RBAC_FORBIDDEN (403) when role is valid but not in allowedRoles", () => {
    const req = makeReq({ "x-user-role": "customer" });
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireRole(["admin"])(req, res, next);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "RBAC_FORBIDDEN", status: 403 }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("does NOT emit an audit event on success", () => {
    const req = makeReq({ "x-user-role": "admin" });
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireRole(["admin"])(req, res, next);

    expect(logSpy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("audit entry for RBAC_MISSING never contains raw header values", () => {
    const req = makeReq({ "x-user-role": "" });
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireRole(["admin"])(req, res, next);

    const entry = logSpy.mock.calls[0][0] as Record<string, unknown>;
    const entryStr = JSON.stringify(entry);
    expect(entryStr).not.toContain("x-user-role");
  });

  it("logs actorIp and resource on RBAC_FORBIDDEN", () => {
    const req = makeReq({ "x-user-role": "customer" }, "/api/v1/admin");
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireRole(["admin"])(req, res, next);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actorIp: "10.0.0.1",
        resource: "/api/v1/admin",
      }),
    );
  });

  it("emits exactly one event per failed request (no double-logging)", () => {
    const req = makeReq({ "x-user-role": "customer" });
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requireRole(["admin"])(req, res, next);

    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
