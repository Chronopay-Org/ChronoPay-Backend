import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Request, Response, NextFunction } from "express";
import { requirePermission, getUserPermissions } from "../middleware/rbac.js";
import { configService } from "../config/config.service.js";
import { createTestAuthorization } from "../../test/auth.js";

const TEST_SECRET = "chronopay-test-jwt-secret-at-least-32-characters";

describe("RBAC Permission Middleware", () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  function setJwtRole(role: string) {
    mockRequest.headers = {
      authorization: createTestAuthorization("permission-user", role),
    };
  }

  beforeEach(() => {
    jest.spyOn(configService, "getAllSecretVersions").mockReturnValue([TEST_SECRET]);
    mockRequest = {
      header: jest.fn<any>(),
      ip: "192.168.1.1",
      originalUrl: "/api/test",
      method: "GET",
    };

    mockResponse = {
      status: jest.fn<any>().mockReturnThis(),
      json: jest.fn<any>().mockReturnThis(),
      setHeader: jest.fn<any>().mockReturnThis(),
    };

    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  describe("requirePermission", () => {
    it("should allow access when user has exact permission", async () => {
      setJwtRole("customer");

      const middleware = requirePermission("bookings:create");
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("should allow access when user has wildcard permission", async () => {
      setJwtRole("admin");

      const middleware = requirePermission("bookings:create");
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("should allow access when user has resource wildcard", async () => {
      setJwtRole("professional");

      const middleware = requirePermission("slots:create");
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("should deny access when user lacks permission", async () => {
      setJwtRole("customer");

      const middleware = requirePermission("users:delete");
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it("should return 401 when role header is missing", async () => {
      mockRequest.headers = {};

      const middleware = requirePermission("bookings:read");
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it("should use customer permissions when the JWT role is invalid", async () => {
      setJwtRole("invalid_role");

      const middleware = requirePermission("bookings:read");
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should throw error when permission is unknown", () => {
      expect(() => {
        requirePermission("unknown:permission");
      }).toThrow("unknown permission");
    });

    it("should throw error when permission is empty", () => {
      expect(() => {
        requirePermission("");
      }).toThrow("must specify a permission");
    });

    it("should handle case insensitive JWT roles", async () => {
      setJwtRole("ADMIN");

      const middleware = requirePermission("bookings:create");
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should handle different permission requirements correctly", async () => {
      setJwtRole("support");

      // Support should have bookings:* (including read)
      const readMiddleware = requirePermission("bookings:read");
      await readMiddleware(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);

      // Reset mocks
      jest.clearAllMocks();

      // Support should NOT have users:delete
      const deleteMiddleware = requirePermission("users:delete");
      await deleteMiddleware(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it("should handle auditor role correctly", async () => {
      setJwtRole("auditor");

      // Auditor should have audit:*
      const auditMiddleware = requirePermission("audit:read");
      await auditMiddleware(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);

      // Reset mocks
      jest.clearAllMocks();

      // Auditor should NOT have bookings permissions
      const bookingMiddleware = requirePermission("bookings:create");
      await bookingMiddleware(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });
  });

  describe("getUserPermissions", () => {
    it("should return all permissions for admin", () => {
      const permissions = getUserPermissions("admin");
      expect(permissions.size).toBeGreaterThan(20);
      expect(permissions.has("bookings:create")).toBe(true);
      expect(permissions.has("users:delete")).toBe(true);
      expect(permissions.has("system:configure")).toBe(true);
    });

    it("should return limited permissions for customer", () => {
      const permissions = getUserPermissions("customer");
      expect(permissions.has("bookings:create")).toBe(true);
      expect(permissions.has("bookings:read")).toBe(true);
      expect(permissions.has("slots:read")).toBe(true);
      expect(permissions.has("users:delete")).toBe(false);
      expect(permissions.has("system:configure")).toBe(false);
    });

    it("should return expanded wildcard permissions for professional", () => {
      const permissions = getUserPermissions("professional");
      expect(permissions.has("slots:create")).toBe(true);
      expect(permissions.has("slots:read")).toBe(true);
      expect(permissions.has("slots:update")).toBe(true);
      expect(permissions.has("slots:delete")).toBe(true);
      expect(permissions.has("bookings:read")).toBe(true);
    });

    it("should return audit permissions for auditor", () => {
      const permissions = getUserPermissions("auditor");
      expect(permissions.has("audit:read")).toBe(true);
      expect(permissions.has("audit:export")).toBe(true);
      expect(permissions.has("reports:read")).toBe(true);
      expect(permissions.has("bookings:create")).toBe(false);
    });

    it("should return empty set for unknown role", () => {
      const permissions = getUserPermissions("unknown_role");
      expect(permissions.size).toBe(0);
    });

    it("should handle case insensitive role names", () => {
      const permissions1 = getUserPermissions("admin");
      const permissions2 = getUserPermissions("ADMIN");
      const permissions3 = getUserPermissions("Admin");

      expect(permissions1.size).toBe(permissions2.size);
      expect(permissions2.size).toBe(permissions3.size);
    });
  });

  describe("Edge Cases and Security", () => {
    it("should prevent privilege escalation via case manipulation", async () => {
      setJwtRole("cUsToMeR");

      const middleware = requirePermission("users:delete");
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it("should handle whitespace in JWT role claims", async () => {
      setJwtRole("  admin  ");

      const middleware = requirePermission("bookings:create");
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it("should reject a request without a verified bearer token", async () => {
      const badRequest = {} as Request;

      const middleware = requirePermission("bookings:read");
      await middleware(badRequest, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it("should fall back to socket address in audit metadata when req.ip is absent", async () => {
      setJwtRole("customer");
      (mockRequest as { ip?: string }).ip = undefined;
      mockRequest.socket = { remoteAddress: "10.0.0.9" } as any;

      const middleware = requirePermission("users:delete");
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it("should tolerate audit logger failures on a denied permission", async () => {
      setJwtRole("customer");
      (mockRequest as { ip?: string }).ip = "192.168.1.1";

      const auditLogger = await import("../services/auditLogger.js");
      const auditSpy = jest
        .spyOn(auditLogger.defaultAuditLogger, "log")
        .mockRejectedValue(new Error("audit backend down"));

      const middleware = requirePermission("users:delete");
      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(403);
      auditSpy.mockRestore();
    });
  });
});
