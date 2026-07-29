import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Request, Response, NextFunction } from "express";
import { requirePermission, getUserPermissions } from "../middleware/rbac.js";

describe("RBAC Permission Middleware", () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
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
      (mockRequest.header as jest.Mock).mockReturnValue("customer");
      
      const middleware = requirePermission("bookings:create");
      await middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("should allow access when user has wildcard permission", async () => {
      (mockRequest.header as jest.Mock).mockReturnValue("admin");
      
      const middleware = requirePermission("bookings:create");
      await middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("should allow access when user has resource wildcard", async () => {
      (mockRequest.header as jest.Mock).mockReturnValue("professional");
      
      const middleware = requirePermission("slots:create");
      await middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("should deny access when user lacks permission", async () => {
      (mockRequest.header as jest.Mock).mockReturnValue("customer");
      
      const middleware = requirePermission("users:delete");
      await middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it("should return 401 when role header is missing", async () => {
      (mockRequest.header as jest.Mock).mockReturnValue(undefined);
      
      const middleware = requirePermission("bookings:read");
      await middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(401);
    });

    it("should return 400 when role is invalid", async () => {
      (mockRequest.header as jest.Mock).mockReturnValue("invalid_role");
      
      const middleware = requirePermission("bookings:read");
      await middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(400);
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

    it("should handle case insensitive role header", async () => {
      (mockRequest.header as jest.Mock).mockReturnValue("ADMIN");
      
      const middleware = requirePermission("bookings:create");
      await middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
    });

    it("should handle different permission requirements correctly", async () => {
      (mockRequest.header as jest.Mock).mockReturnValue("support");
      
      // Support should have bookings:* (including read)
      const readMiddleware = requirePermission("bookings:read");
      await readMiddleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );
      expect(mockNext).toHaveBeenCalledTimes(1);

      // Reset mocks
      jest.clearAllMocks();

      // Support should NOT have users:delete
      const deleteMiddleware = requirePermission("users:delete");
      await deleteMiddleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it("should handle auditor role correctly", async () => {
      (mockRequest.header as jest.Mock).mockReturnValue("auditor");
      
      // Auditor should have audit:*
      const auditMiddleware = requirePermission("audit:read");
      await auditMiddleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );
      expect(mockNext).toHaveBeenCalledTimes(1);

      // Reset mocks
      jest.clearAllMocks();

      // Auditor should NOT have bookings permissions
      const bookingMiddleware = requirePermission("bookings:create");
      await bookingMiddleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );
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
      (mockRequest.header as jest.Mock).mockReturnValue("cUsToMeR");
      
      const middleware = requirePermission("users:delete");
      await middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(403);
    });

    it("should handle whitespace in role header", async () => {
      (mockRequest.header as jest.Mock).mockReturnValue("  admin  ");
      
      const middleware = requirePermission("bookings:create");
      await middleware(
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalled();
    });

    it("should handle missing socket when IP is unavailable", async () => {
      // Force an error by passing invalid request
      const badRequest = {} as Request;
      
      const middleware = requirePermission("bookings:read");
      await middleware(
        badRequest,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(500);
    });
  });
});
