import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";
import {
  parseRole,
  parseJwtRole,
  getUserId,
  readBearerToken,
  requireAuth,
  requireAuthenticatedActor,
  authenticateToken,
} from "../auth.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";
import { signJwt } from "../../utils/jwt.js";
import { configService } from "../../config/config.service.js";

const TEST_SECRET = "test-jwt-secret-with-at-least-32-characters-length";

async function makeJwt(
  payload: Record<string, unknown> = {},
  options?: { expiresInSec?: number; issuer?: string; audience?: string; secret?: string },
) {
  const now = Math.floor(Date.now() / 1000);
  const secret = options?.secret ?? TEST_SECRET;
  const claims = {
    iat: now,
    exp: now + (options?.expiresInSec ?? 3600),
    ...payload,
  };
  return signJwt(claims, secret, options);
}

describe("auth middleware & ChronoPayRole contract", () => {
  let auditSpy: jest.SpiedFunction<typeof defaultAuditLogger.log>;

  beforeEach(() => {
    auditSpy = jest.spyOn(defaultAuditLogger, "log").mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    auditSpy.mockRestore();
    jest.restoreAllMocks();
  });

  // =========================================================================
  // 1. Evidence: src/middleware/auth.ts:37 -> return null;
  // =========================================================================
  describe("parseRole (evidence line 37: return null)", () => {
    it("returns null for non-string inputs", () => {
      expect(parseRole(null)).toBeNull();
      expect(parseRole(undefined)).toBeNull();
      expect(parseRole(123)).toBeNull();
      expect(parseRole(true)).toBeNull();
      expect(parseRole(false)).toBeNull();
      expect(parseRole({})).toBeNull();
      expect(parseRole([])).toBeNull();
      expect(parseRole(Symbol("role"))).toBeNull();
      expect(parseRole(() => "admin")).toBeNull();
    });

    it("returns null for empty or whitespace-only strings", () => {
      expect(parseRole("")).toBeNull();
      expect(parseRole("   ")).toBeNull();
      expect(parseRole("\t\n  ")).toBeNull();
    });

    it("returns null for unknown role strings", () => {
      expect(parseRole("superuser")).toBeNull();
      expect(parseRole("hacker")).toBeNull();
      expect(parseRole("root")).toBeNull();
      expect(parseRole("anonymous")).toBeNull();
      expect(parseRole("null")).toBeNull();
      expect(parseRole("undefined")).toBeNull();
    });

    it("returns normalized role for known roles (neighboring normal path)", () => {
      expect(parseRole("admin")).toBe("admin");
      expect(parseRole("customer")).toBe("customer");
      expect(parseRole("support")).toBe("support");
      expect(parseRole("auditor")).toBe("auditor");
      expect(parseRole("professional")).toBe("professional");
      expect(parseRole("supplier")).toBe("supplier");
    });

    it("normalizes case and trims whitespace on valid roles", () => {
      expect(parseRole("  ADMIN  ")).toBe("admin");
      expect(parseRole("  Customer\t")).toBe("customer");
      expect(parseRole("SuPpOrT")).toBe("support");
      expect(parseRole("\n  Auditor ")).toBe("auditor");
      expect(parseRole("  PROFESSIONAL  ")).toBe("professional");
      expect(parseRole(" Supplier ")).toBe("supplier");
    });
  });

  describe("parseJwtRole", () => {
    it("defaults to customer when role is absent, invalid, or non-string", () => {
      expect(parseJwtRole(undefined)).toBe("customer");
      expect(parseJwtRole(null)).toBe("customer");
      expect(parseJwtRole("")).toBe("customer");
      expect(parseJwtRole("invalid_role")).toBe("customer");
      expect(parseJwtRole(123)).toBe("customer");
      expect(parseJwtRole({})).toBe("customer");
    });

    it("returns parsed role when a valid known role is provided", () => {
      expect(parseJwtRole("admin")).toBe("admin");
      expect(parseJwtRole("  ADMIN ")).toBe("admin");
      expect(parseJwtRole("support")).toBe("support");
      expect(parseJwtRole("supplier")).toBe("supplier");
      expect(parseJwtRole("customer")).toBe("customer");
    });
  });

  describe("getUserId", () => {
    it("extracts sub when present", () => {
      expect(getUserId({ sub: "user-123", exp: 1 } as any)).toBe("user-123");
      expect(getUserId({ sub: "  user-trimmed  ", exp: 1 } as any)).toBe("user-trimmed");
    });

    it("falls back to id when sub is null or undefined", () => {
      expect(getUserId({ id: "user-456", exp: 1 } as any)).toBe("user-456");
      expect(getUserId({ sub: null as any, id: "user-456", exp: 1 } as any)).toBe("user-456");
      expect(getUserId({ sub: undefined, id: "  user-trimmed-id  ", exp: 1 } as any)).toBe("user-trimmed-id");
    });

    it("does not fall back to id when sub is empty or whitespace string (candidate is empty string)", () => {
      expect(getUserId({ sub: "", id: "user-456", exp: 1 } as any)).toBe("");
      expect(getUserId({ sub: "   ", id: "user-456", exp: 1 } as any)).toBe("");
    });

    it("prefers sub over id when both are present", () => {
      expect(getUserId({ sub: "sub-id", id: "alt-id", exp: 1 } as any)).toBe("sub-id");
    });

    it("returns empty string when neither sub nor id is present or valid", () => {
      expect(getUserId({ exp: 1 } as any)).toBe("");
      expect(getUserId({ sub: "", id: "", exp: 1 } as any)).toBe("");
      expect(getUserId({ sub: "   ", id: "   ", exp: 1 } as any)).toBe("");
      expect(getUserId({ sub: 123, id: 456, exp: 1 } as any)).toBe("");
    });
  });

  // =========================================================================
  // 2. Evidence: src/middleware/auth.ts:52 -> return null;
  // =========================================================================
  describe("readBearerToken (evidence line 52: return null)", () => {
    it("returns null when authorization header is missing or empty", () => {
      const reqMissing = { headers: {} } as Request;
      expect(readBearerToken(reqMissing)).toBeNull();

      const reqUndefined = { headers: { authorization: undefined } } as unknown as Request;
      expect(readBearerToken(reqUndefined)).toBeNull();

      const reqEmpty = { headers: { authorization: "" } } as unknown as Request;
      expect(readBearerToken(reqEmpty)).toBeNull();
    });

    it("returns null when authorization scheme is not Bearer", () => {
      expect(readBearerToken({ headers: { authorization: "Basic dXNlcjpwYXNz" } } as Request)).toBeNull();
      expect(readBearerToken({ headers: { authorization: "Token my-secret-token" } } as Request)).toBeNull();
      expect(readBearerToken({ headers: { authorization: "Bearer" } } as Request)).toBeNull();
      expect(readBearerToken({ headers: { authorization: "bearer token" } } as Request)).toBeNull();
      expect(readBearerToken({ headers: { authorization: "BEARER token" } } as Request)).toBeNull();
      expect(readBearerToken({ headers: { authorization: "BearerNoSpace" } } as Request)).toBeNull();
    });

    it("returns null when token payload is empty or whitespace (line 56 boundary)", () => {
      expect(readBearerToken({ headers: { authorization: "Bearer " } } as Request)).toBeNull();
      expect(readBearerToken({ headers: { authorization: "Bearer    " } } as Request)).toBeNull();
      expect(readBearerToken({ headers: { authorization: "Bearer \t  " } } as Request)).toBeNull();
    });

    it("extracts and trims token string when Bearer scheme is valid", () => {
      expect(readBearerToken({ headers: { authorization: "Bearer my-valid-token" } } as Request)).toBe(
        "my-valid-token",
      );
      expect(readBearerToken({ headers: { authorization: "Bearer   spaced-token   " } } as Request)).toBe(
        "spaced-token",
      );
    });
  });

  describe("requireAuth middleware", () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;
    let statusMock: jest.Mock;
    let jsonMock: jest.Mock;

    beforeEach(() => {
      jsonMock = jest.fn();
      statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      mockReq = { headers: {} };
      mockRes = { status: statusMock as any, json: jsonMock as any };
      mockNext = jest.fn();
      jest.spyOn(configService, "getAllSecretVersions").mockReturnValue([TEST_SECRET]);
    });

    it("returns 401 when token cannot be read from request", async () => {
      const middleware = requireAuth();
      await middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Missing Authorization header",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 when token has non-Bearer scheme", async () => {
      mockReq.headers = { authorization: "Token abc123" };
      const middleware = requireAuth();
      await middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Missing Authorization header",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 when token is invalid or expired", async () => {
      mockReq.headers = { authorization: "Bearer invalid.token.value" };

      const middleware = requireAuth();
      await middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Invalid or expired token",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("populates req.user and req.auth and calls next on successful verification", async () => {
      const token = await makeJwt(
        { sub: "user-admin", role: "admin" },
        { expiresInSec: 3600 },
      );
      mockReq.headers = { authorization: `Bearer ${token}` };

      const middleware = requireAuth();
      await middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.user).toMatchObject({
        sub: "user-admin",
        role: "admin",
      });
      expect(mockReq.auth).toMatchObject({
        userId: "user-admin",
        role: "admin",
      });
    });

    it("falls back to customer role when token role claim is missing or invalid", async () => {
      const token = await makeJwt(
        { sub: "user-default", role: "unknown_role" },
        { expiresInSec: 3600 },
      );
      mockReq.headers = { authorization: `Bearer ${token}` };

      const middleware = requireAuth();
      await middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.auth?.role).toBe("customer");
    });

    it("forwards expectedIssuer and verifies correctly", async () => {
      const token = await makeJwt(
        { sub: "user-issuer" },
        { expiresInSec: 3600, issuer: "expected-issuer" },
      );
      mockReq.headers = { authorization: `Bearer ${token}` };

      const middleware = requireAuth("expected-issuer");
      await middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.auth?.userId).toBe("user-issuer");
    });

    it("rejects token when issuer does not match expectedIssuer", async () => {
      const token = await makeJwt(
        { sub: "user-wrong-issuer" },
        { expiresInSec: 3600, issuer: "wrong-issuer" },
      );
      mockReq.headers = { authorization: `Bearer ${token}` };

      const middleware = requireAuth("expected-issuer");
      await middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Invalid or expired token",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Evidence: src/middleware/auth.ts:90 -> throw new Error(...)
  // =========================================================================
  describe("requireAuthenticatedActor declaration contract (evidence line 90)", () => {
    it("throws an error when an unknown role is declared", () => {
      expect(() => requireAuthenticatedActor(["unknownRole" as any])).toThrow(
        "requireAuthenticatedActor declares unknown role unknownrole",
      );
      expect(() => requireAuthenticatedActor(["superuser" as any])).toThrow(
        "requireAuthenticatedActor declares unknown role superuser",
      );
      expect(() => requireAuthenticatedActor(["hacker" as any])).toThrow(
        "requireAuthenticatedActor declares unknown role hacker",
      );
    });

    it("throws an error when empty or whitespace-only role is declared", () => {
      expect(() => requireAuthenticatedActor([""])).toThrow(
        "requireAuthenticatedActor declares unknown role ",
      );
      expect(() => requireAuthenticatedActor(["   "])).toThrow(
        "requireAuthenticatedActor declares unknown role ",
      );
    });

    it("throws an error when mixed with known and unknown roles", () => {
      expect(() => requireAuthenticatedActor(["admin", "ghost" as any])).toThrow(
        "requireAuthenticatedActor declares unknown role ghost",
      );
      expect(() => requireAuthenticatedActor(["support", "superadmin" as any])).toThrow(
        "requireAuthenticatedActor declares unknown role superadmin",
      );
    });

    it("succeeds when all declared roles are valid known roles", () => {
      expect(() => requireAuthenticatedActor(["admin"])).not.toThrow();
      expect(() => requireAuthenticatedActor(["support", "auditor"])).not.toThrow();
      expect(() => requireAuthenticatedActor(["customer", "professional", "supplier"])).not.toThrow();
    });

    it("normalizes case and trims whitespace during role declaration", () => {
      expect(() => requireAuthenticatedActor([" ADMIN ", "  SUPPORT  "])).not.toThrow();
    });

    it("exports authenticateToken as an alias for requireAuthenticatedActor", () => {
      expect(authenticateToken).toBe(requireAuthenticatedActor);
    });
  });

  // =========================================================================
  // 4. requireAuthenticatedActor runtime middleware behavior & error contracts
  // =========================================================================
  describe("requireAuthenticatedActor runtime behavior", () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;
    let statusMock: jest.Mock;
    let jsonMock: jest.Mock;

    beforeEach(() => {
      jsonMock = jest.fn();
      statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      mockReq = {
        headers: {},
        ip: "127.0.0.1",
        method: "GET",
        originalUrl: "/test-endpoint",
      };
      mockRes = { status: statusMock as any, json: jsonMock as any };
      mockNext = jest.fn();
    });

    it("returns 401 when x-chronopay-user-id header is missing", () => {
      mockReq.headers = { "x-chronopay-role": "admin" };
      const middleware = requireAuthenticatedActor(["admin"]);
      middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Authentication required.",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 when x-chronopay-user-id header is empty or whitespace", () => {
      mockReq.headers = { "x-chronopay-user-id": "", "x-chronopay-role": "admin" };
      const middleware = requireAuthenticatedActor(["admin"]);
      middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Authentication required.",
      });

      statusMock.mockClear();
      jsonMock.mockClear();
      mockReq.headers = { "x-chronopay-user-id": "   ", "x-chronopay-role": "admin" };
      middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Authentication required.",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 401 and audits RBAC_MISSING when x-chronopay-role is absent (line 37 return null path)", () => {
      mockReq.headers = { "x-chronopay-user-id": "user-123" };
      const middleware = requireAuthenticatedActor(["admin"]);
      middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Role is not authorized for this action.",
      });
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "RBAC_MISSING",
          resource: "/test-endpoint",
          status: 401,
        }),
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 400 and audits RBAC_INVALID_ROLE when x-chronopay-role is invalid (line 37 return null path)", () => {
      mockReq.headers = {
        "x-chronopay-user-id": "user-123",
        "x-chronopay-role": "hacker",
      };
      const middleware = requireAuthenticatedActor(["admin"]);
      middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Role is not authorized for this action.",
      });
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "RBAC_INVALID_ROLE",
          resource: "/test-endpoint",
          status: 400,
        }),
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("returns 403 and audits RBAC_FORBIDDEN when role is known but does not satisfy requiredRoles", () => {
      mockReq.headers = {
        "x-chronopay-user-id": "user-123",
        "x-chronopay-role": "customer",
      };
      const middleware = requireAuthenticatedActor(["admin"]);
      middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Role is not authorized for this action.",
      });
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "RBAC_FORBIDDEN",
          status: 403,
          metadata: expect.objectContaining({
            role: "customer",
            requiredRoles: ["admin"],
          }),
        }),
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("authorizes when user role satisfies required role directly", () => {
      mockReq.headers = {
        "x-chronopay-user-id": "  user-123  ",
        "x-chronopay-role": "customer",
      };
      const middleware = requireAuthenticatedActor(["customer"]);
      middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.auth).toEqual({
        userId: "user-123",
        role: "customer",
        claims: {},
      });
      expect(statusMock).not.toHaveBeenCalled();
    });

    it("authorizes when user role satisfies required role via role hierarchy", () => {
      mockReq.headers = {
        "x-chronopay-user-id": "admin-1",
        "x-chronopay-role": "ADMIN",
      };
      const middleware = requireAuthenticatedActor(["support"]);
      middleware(mockReq as Request, mockRes as Response, mockNext as unknown as NextFunction);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.auth).toEqual({
        userId: "admin-1",
        role: "admin",
        claims: {},
      });
      expect(statusMock).not.toHaveBeenCalled();
    });

    it("catches unexpected exceptions and returns 401", () => {
      const badReq = {
        get headers(): any {
          throw new Error("unhandled stream failure");
        },
      } as unknown as Request;

      const middleware = requireAuthenticatedActor(["admin"]);
      middleware(badReq, mockRes as Response, mockNext as unknown as NextFunction);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Invalid or expired token",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });
});
