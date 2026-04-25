/**
 * Unit tests for log context builder utilities
 * Tests standardized log field generation for middleware
 */

import { Request } from "express";
import {
  buildRequestLogContext,
  addIdentityToContext,
  addResponseData,
  extractIdentity,
  RequestLogContext,
  IdentityContext,
} from "../utils/logContext.js";

describe("Log Context Builder", () => {
  describe("buildRequestLogContext", () => {
    it("should build context from basic request", () => {
      const mockReq = {
        method: "GET",
        path: "/api/users",
        originalUrl: "/api/users",
        route: { path: "/api/users" },
        ip: "192.168.1.1",
        headers: { "user-agent": "test-agent" },
        get: (header: string) => {
          if (header === "user-agent") return "test-agent";
          return undefined;
        },
      } as unknown as Request;

      const context = buildRequestLogContext(mockReq);

      expect(context.requestId).toBeDefined();
      expect(context.requestId).toMatch(/^req_/);
      expect(context.route).toBe("/api/users");
      expect(context.method).toBe("GET");
      expect(context.ip).toBe("192.168.1.1");
      expect(context.userAgent).toBe("test-agent");
    });

    it("should use existing request ID if present", () => {
      const mockReq = {
        method: "POST",
        path: "/api/payment",
        originalUrl: "/api/payment",
        route: { path: "/api/payment" },
        id: "existing-req-123",
        get: (header: string) => {
          if (header === "user-agent") return undefined;
          return undefined;
        },
      } as unknown as Request;

      const context = buildRequestLogContext(mockReq);

      expect(context.requestId).toBe("existing-req-123");
    });

    it("should sanitize route parameters", () => {
      const mockReq = {
        method: "GET",
        path: "/api/users/123",
        originalUrl: "/api/users/123",
        route: { path: "/api/users/:id" },
        get: (header: string) => {
          if (header === "user-agent") return undefined;
          return undefined;
        },
      } as unknown as Request;

      const context = buildRequestLogContext(mockReq);

      expect(context.route).toBe("/api/users/:REDACTED");
    });

    it("should handle missing route using originalUrl", () => {
      const mockReq = {
        method: "GET",
        path: "",
        originalUrl: "/api/health",
        route: undefined,
        get: (header: string) => {
          if (header === "user-agent") return undefined;
          return undefined;
        },
      } as unknown as Request;

      const context = buildRequestLogContext(mockReq);

      expect(context.route).toBe("/api/health");
    });

    it("should handle empty request properties", () => {
      const mockReq = {
        method: undefined,
        path: undefined,
        originalUrl: undefined,
        route: undefined,
        get: (header: string) => {
          if (header === "user-agent") return undefined;
          return undefined;
        },
      } as unknown as Request;

      const context = buildRequestLogContext(mockReq);

      expect(context.method).toBe("UNKNOWN");
      expect(context.route).toBe("__route_placeholder__");
    });
  });

  describe("addIdentityToContext", () => {
    it("should add userId to context", () => {
      const context: RequestLogContext = {
        requestId: "req-123",
        route: "/api/users",
        method: "GET",
      };

      const identity: IdentityContext = { userId: "user-456" };

      const result = addIdentityToContext(context, identity);

      expect(result.userId).toBe("user-456");
      expect(result.requestId).toBe("req-123");
    });

    it("should add apiKeyId to context when no userId", () => {
      const context: RequestLogContext = {
        requestId: "req-123",
        route: "/api/users",
        method: "GET",
      };

      const identity: IdentityContext = { apiKeyId: "key-789" };

      const result = addIdentityToContext(context, identity);

      expect(result.apiKeyId).toBe("key-789");
      expect(result.userId).toBeUndefined();
    });

    it("should prefer userId over apiKeyId", () => {
      const context: RequestLogContext = {
        requestId: "req-123",
        route: "/api/users",
        method: "GET",
      };

      const identity: IdentityContext = { userId: "user-456", apiKeyId: "key-789" };

      const result = addIdentityToContext(context, identity);

      expect(result.userId).toBe("user-456");
      expect(result.apiKeyId).toBeUndefined();
    });

    it("should return original context when no identity", () => {
      const context: RequestLogContext = {
        requestId: "req-123",
        route: "/api/users",
        method: "GET",
      };

      const identity: IdentityContext = {};

      const result = addIdentityToContext(context, identity);

      expect(result).toBe(context);
    });
  });

  describe("addResponseData", () => {
    it("should add status and duration to context", () => {
      const context: RequestLogContext = {
        requestId: "req-123",
        route: "/api/users",
        method: "GET",
      };

      const result = addResponseData(context, 200, 150);

      expect(result.status).toBe(200);
      expect(result.duration).toBe(150);
    });

    it("should preserve existing context fields", () => {
      const context: RequestLogContext = {
        requestId: "req-123",
        route: "/api/users",
        method: "GET",
        userId: "user-456",
        ip: "192.168.1.1",
      };

      const result = addResponseData(context, 201, 50);

      expect(result.status).toBe(201);
      expect(result.duration).toBe(50);
      expect(result.userId).toBe("user-456");
      expect(result.ip).toBe("192.168.1.1");
    });
  });

  describe("extractIdentity", () => {
    it("should extract userId from logContext", () => {
      const mockReq = {
        logContext: { userId: "user-123" },
      } as unknown as Request;

      const identity = extractIdentity(mockReq);

      expect(identity.userId).toBe("user-123");
    });

    it("should extract apiKeyId from logContext", () => {
      const mockReq = {
        logContext: { apiKeyId: "key-456" },
      } as unknown as Request;

      const identity = extractIdentity(mockReq);

      expect(identity.apiKeyId).toBe("key-456");
    });

    it("should extract userId from auth", () => {
      const mockReq = {
        auth: { userId: "user-789", role: "customer" },
      } as unknown as Request;

      const identity = extractIdentity(mockReq);

      expect(identity.userId).toBe("user-789");
    });

    it("should extract apiKeyId from header", () => {
      const mockReq = {
        header: (name: string) => {
          if (name === "x-api-key-id") return "header-key-123";
          return undefined;
        },
      } as unknown as Request;

      const identity = extractIdentity(mockReq);

      expect(identity.apiKeyId).toBe("header-key-123");
    });

    it("should prefer logContext.userId over auth.userId", () => {
      const mockReq = {
        logContext: { userId: "log-user" },
        auth: { userId: "auth-user", role: "customer" },
      } as unknown as Request;

      const identity = extractIdentity(mockReq);

      expect(identity.userId).toBe("log-user");
    });

    it("should return empty object when no identity", () => {
      const mockReq = {
        header: (name: string) => undefined,
      } as unknown as Request;

      const identity = extractIdentity(mockReq);

      expect(identity).toEqual({});
    });
  });
});