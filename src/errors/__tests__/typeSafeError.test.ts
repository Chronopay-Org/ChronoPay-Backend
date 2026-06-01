/**
 * Tests for type-safe error sender functions.
 *
 * Validates:
 * - sendPublicError: only accepts public error codes
 * - sendInternalError: only accepts internal error codes
 * - sendError: generic error sender with fallback
 * - i18n message resolution in responses
 * - HTTP status code correctness
 * - Details handling and security
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Response } from "express";
import {
  sendPublicError,
  sendInternalError,
  sendError,
  sendErrorResponse,
  type SendErrorOptions,
} from "../typeSafeError.js";
import { AppError, ValidationError, NotFoundError } from "../AppError.js";

// Mock Express Response
const createMockResponse = (): Response => {
  const response: Partial<Response> = {
    status: jest.fn().mockReturnThis() as any,
    json: jest.fn().mockReturnThis() as any,
  };
  return response as Response;
};

describe("Type-Safe Error Sender", () => {
  let mockRes: Response;

  beforeEach(() => {
    mockRes = createMockResponse();
    process.env.NODE_ENV = "development";
  });

  describe("sendPublicError", () => {
    it("should send valid public error code", () => {
      sendPublicError(mockRes, "NOT_FOUND", "User not found");

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalled();

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.success).toBe(false);
      expect(jsonCall.code).toBe("NOT_FOUND");
      expect(jsonCall.timestamp).toBeDefined();
    });

    it("should resolve i18n message for public error", () => {
      sendPublicError(mockRes, "VALIDATION_ERROR", "Invalid input", {
        locale: "en",
      });

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.message).not.toBeUndefined();
      expect(typeof jsonCall.message).toBe("string");
    });

    it("should include details in response", () => {
      sendPublicError(mockRes, "NOT_FOUND", "User not found", {
        details: { userId: 123 },
      });

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.details).toEqual({ userId: 123 });
    });

    it("should use default locale (en) if not specified", () => {
      sendPublicError(mockRes, "BAD_REQUEST", "Bad request");

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.message).toBeDefined();
      // English message should be present
      expect(typeof jsonCall.message).toBe("string");
    });

    it("should reject invalid public error code", () => {
      expect(() => {
        sendPublicError(mockRes, "DB_ERROR" as any, "Should fail");
      }).toThrow(/Invalid public error code/);
    });

    it("should include request error message", () => {
      sendPublicError(mockRes, "CONFLICT", "Resource already exists");

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.error).toBe("Resource already exists");
    });

    it("should set correct HTTP status for different codes", () => {
      const cases: Array<[any, number]> = [
        ["BAD_REQUEST", 400],
        ["UNAUTHORIZED", 401],
        ["FORBIDDEN", 403],
        ["NOT_FOUND", 404],
        ["CONFLICT", 409],
        ["UNPROCESSABLE_ENTITY", 422],
        ["RATE_LIMITED", 429],
      ];

      cases.forEach(([code, expectedStatus]) => {
        mockRes = createMockResponse();
        sendPublicError(mockRes, code, "Test error");
        expect(mockRes.status).toHaveBeenCalledWith(expectedStatus);
      });
    });
  });

  describe("sendInternalError", () => {
    it("should send valid internal error code", () => {
      sendInternalError(mockRes, "DB_ERROR", "Query timeout");

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalled();

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.success).toBe(false);
      expect(jsonCall.code).toBe("DB_ERROR");
    });

    it("should hide error details in production", () => {
      process.env.NODE_ENV = "production";
      sendInternalError(mockRes, "DB_ERROR", "Query timeout", {
        details: { query: "SELECT * FROM users" },
      });

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.details).toBeUndefined();
      expect(jsonCall.error).toBe("Internal server error");
    });

    it("should expose error details in development", () => {
      process.env.NODE_ENV = "development";
      sendInternalError(mockRes, "DB_ERROR", "Query timeout", {
        details: { query: "SELECT * FROM users" },
      });

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.details).toBeDefined();
      expect(jsonCall.error).toBe("Query timeout");
    });

    it("should mask error code in production", () => {
      process.env.NODE_ENV = "production";
      sendInternalError(mockRes, "CONFIGURATION_ERROR", "Invalid config");

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.code).toBe("INTERNAL_ERROR");
    });

    it("should show actual error code in development", () => {
      process.env.NODE_ENV = "development";
      sendInternalError(mockRes, "CONFIGURATION_ERROR", "Invalid config");

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.code).toBe("CONFIGURATION_ERROR");
    });

    it("should reject invalid internal error code", () => {
      expect(() => {
        sendInternalError(mockRes, "NOT_FOUND" as any, "Should fail");
      }).toThrow(/Invalid internal error code/);
    });

    it("should set correct HTTP status for different codes", () => {
      const cases: Array<[any, number]> = [
        ["DB_ERROR", 500],
        ["INTERNAL_ERROR", 500],
        ["SERVICE_UNAVAILABLE", 503],
        ["CONFIGURATION_ERROR", 503],
      ];

      cases.forEach(([code, expectedStatus]) => {
        mockRes = createMockResponse();
        sendInternalError(mockRes, code, "Test error");
        expect(mockRes.status).toHaveBeenCalledWith(expectedStatus);
      });
    });
  });

  describe("sendError (generic)", () => {
    it("should send public errors via sendPublicError", () => {
      sendError(mockRes, "NOT_FOUND", "Not found");

      expect(mockRes.status).toHaveBeenCalledWith(404);
      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.code).toBe("NOT_FOUND");
    });

    it("should send internal errors via sendInternalError", () => {
      sendError(mockRes, "DB_ERROR", "Database failed");

      expect(mockRes.status).toHaveBeenCalledWith(500);
      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      // In dev mode, should show actual code
      expect(["DB_ERROR", "INTERNAL_ERROR"]).toContain(jsonCall.code);
    });

    it("should reject unknown error codes", () => {
      expect(() => {
        sendError(mockRes, "UNKNOWN_CODE" as any, "Unknown");
      }).toThrow(/Unknown error code/);
    });

    it("should pass through options to appropriate sender", () => {
      const options: SendErrorOptions = {
        locale: "es",
        details: { field: "email" },
      };

      sendError(mockRes, "BAD_REQUEST", "Invalid input", options);

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.details).toEqual({ field: "email" });
    });
  });

  describe("sendErrorResponse (legacy)", () => {
    it("should emit legacy error envelope", () => {
      const err = new ValidationError("Invalid input", { field: "name" });
      sendErrorResponse(mockRes, err);

      expect(mockRes.status).toHaveBeenCalledWith(err.statusCode);
      expect(mockRes.json).toHaveBeenCalled();

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.code).toBe("VALIDATION_ERROR");
      expect(jsonCall.details).toEqual({ field: "name" });
    });

    it("should attach request ID if provided", () => {
      const err = new NotFoundError("Resource not found");
      const mockReq = { requestId: "req-123", id: "backup-id" } as any;

      sendErrorResponse(mockRes, err, mockReq);

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.requestId).toBe("req-123");
    });

    it("should use fallback request id", () => {
      const err = new NotFoundError();
      const mockReq = { id: "backup-id" } as any;

      sendErrorResponse(mockRes, err, mockReq);

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.requestId).toBe("backup-id");
    });
  });

  describe("i18n Message Resolution", () => {
    it("should resolve Spanish messages", () => {
      sendPublicError(mockRes, "VALIDATION_ERROR", "Test", { locale: "es" });

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(typeof jsonCall.message).toBe("string");
      expect(jsonCall.message.length).toBeGreaterThan(0);
    });

    it("should fallback to English if locale not found", () => {
      // Unsupported locale should fallback
      sendPublicError(
        mockRes,
        "NOT_FOUND",
        "Test",
        { locale: "unsupported" as any },
      );

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(typeof jsonCall.message).toBe("string");
    });
  });

  describe("Response Shape", () => {
    it("should always include success: false", () => {
      sendPublicError(mockRes, "BAD_REQUEST", "Test");

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.success).toBe(false);
    });

    it("should always include timestamp", () => {
      sendPublicError(mockRes, "NOT_FOUND", "Test");

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.timestamp).toBeDefined();
      expect(typeof jsonCall.timestamp).toBe("string");
      expect(new Date(jsonCall.timestamp).getTime()).toBeGreaterThan(0);
    });

    it("should include code and message", () => {
      sendPublicError(mockRes, "CONFLICT", "Test");

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.code).toBe("CONFLICT");
      expect(jsonCall.message).toBeDefined();
    });

    it("should not include details if not provided", () => {
      sendPublicError(mockRes, "BAD_REQUEST", "Test");

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.details).toBeUndefined();
    });
  });

  describe("Type Safety Guarantees", () => {
    it("should only accept known public codes for sendPublicError", () => {
      // Valid codes should work
      const validCodes = ["NOT_FOUND", "FORBIDDEN", "RATE_LIMITED"] as const;

      validCodes.forEach((code) => {
        mockRes = createMockResponse();
        expect(() => sendPublicError(mockRes, code, "Test")).not.toThrow();
      });
    });

    it("should only accept known internal codes for sendInternalError", () => {
      // Valid codes should work
      const validCodes = ["DB_ERROR", "INTERNAL_ERROR", "SERVICE_UNAVAILABLE"] as const;

      validCodes.forEach((code) => {
        mockRes = createMockResponse();
        expect(() => sendInternalError(mockRes, code, "Test")).not.toThrow();
      });
    });
  });

  describe("Security", () => {
    it("should not expose internal details in production", () => {
      process.env.NODE_ENV = "production";
      const sensitiveDetails = {
        sql: "SELECT * FROM users WHERE id=1",
        stack: "Error at line 42",
        env: "DATABASE_URL=secret",
      };

      sendInternalError(mockRes, "DB_ERROR", "DB failed", {
        details: sensitiveDetails,
      });

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.details).toBeUndefined();
    });

    it("should always mask internal error codes in production", () => {
      process.env.NODE_ENV = "production";

      sendInternalError(mockRes, "CONFIGURATION_ERROR", "Bad config");

      const jsonCall = (mockRes.json as jest.Mock).mock.calls[0][0];
      expect(jsonCall.code).toBe("INTERNAL_ERROR");
    });

    it("should reject unknown error codes at runtime", () => {
      expect(() => {
        sendError(mockRes, "HACKER_INJECTION" as any, "Attempt");
      }).toThrow();
    });
  });
});
