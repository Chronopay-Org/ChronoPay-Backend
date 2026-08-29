/**
 * Tests for the type-safe error senders.
 *
 * Validates:
 * - sendPublicError: only accepts known public codes
 * - sendInternalError: only accepts known internal codes + production masking
 * - sendError: routing by scope and rejection of unknown codes
 * - sendErrorResponse: legacy AppError envelope with requestId propagation
 * - i18n message resolution and response envelope shape
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Response } from "express";
import {
  sendPublicError,
  sendInternalError,
  sendError,
  sendErrorResponse,
  type SendErrorOptions,
} from "../sendError.js";
import { ValidationError, NotFoundError, InternalServerError, DatabaseError } from "../AppError.js";

const createMockResponse = (): Response => {
  const response: Partial<Response> = {
    status: jest.fn().mockReturnThis() as unknown,
    json: jest.fn().mockReturnThis() as unknown,
  };
  return response as Response;
};

describe("Type-Safe Error Sender", () => {
  let mockRes: Response;

  beforeEach(() => {
    mockRes = createMockResponse();
    process.env.NODE_ENV = "development";
  });

  const lastJson = (): Record<string, unknown> =>
    (mockRes.json as unknown as jest.Mock).mock.calls[0][0] as Record<string, unknown>;

  describe("sendPublicError", () => {
    it("sends a valid public error code with the taxonomy status", () => {
      sendPublicError(mockRes, "NOT_FOUND", "User not found");

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalled();
      expect(lastJson().success).toBe(false);
      expect(lastJson().code).toBe("NOT_FOUND");
      expect(lastJson().timestamp).toBeDefined();
    });

    it("resolves the i18n message for the code", () => {
      sendPublicError(mockRes, "VALIDATION_ERROR", "Invalid input", {
        locale: "en",
      });

      expect(typeof lastJson().message).toBe("string");
      expect(lastJson().message).not.toBe("errors.validation.validation_error");
    });

    it("attaches options.details when provided", () => {
      sendPublicError(mockRes, "NOT_FOUND", "User not found", {
        details: { userId: 123 },
      });

      expect(lastJson().details).toEqual({ userId: 123 });
    });

    it("defaults to the English locale when unspecified", () => {
      sendPublicError(mockRes, "BAD_REQUEST", "Bad request");

      expect(typeof lastJson().message).toBe("string");
    });

    it("rejects an internal code passed as public", () => {
      expect(() => {
        sendPublicError(mockRes, "DB_ERROR" as never, "Should fail");
      }).toThrow(/Invalid public error code/);
    });

    it("rejects an unknown code at runtime", () => {
      expect(() => {
        sendPublicError(mockRes, "HACKER_INJECTION" as never, "Attempt");
      }).toThrow(/Unknown error code/);
    });

    it("reports the caller-facing message in the error field", () => {
      sendPublicError(mockRes, "CONFLICT", "Resource already exists");

      expect(lastJson().error).toBe("Resource already exists");
    });

    it("maps each public code to the correct HTTP status", () => {
      const cases: Array<[string, number]> = [
        ["BAD_REQUEST", 400],
        ["UNAUTHORIZED", 401],
        ["FORBIDDEN", 403],
        ["NOT_FOUND", 404],
        ["CONFLICT", 409],
        ["UNPROCESSABLE_ENTITY", 422],
        ["RATE_LIMITED", 429],
        ["QUERY_BUDGET_EXCEEDED", 503],
      ];

      cases.forEach(([code, expectedStatus]) => {
        mockRes = createMockResponse();
        sendPublicError(mockRes, code as never, "Test error");
        expect(mockRes.status).toHaveBeenCalledWith(expectedStatus);
      });
    });
  });

  describe("sendInternalError", () => {
    it("sends a valid internal error code in development", () => {
      sendInternalError(mockRes, "DB_ERROR", "Query timeout");

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(lastJson().success).toBe(false);
      expect(lastJson().code).toBe("DB_ERROR");
    });

    it("hides details and masks the code in production", () => {
      process.env.NODE_ENV = "production";
      sendInternalError(mockRes, "DB_ERROR", "Query timeout", {
        details: { query: "SELECT * FROM users" },
      });

      expect(lastJson().details).toBeUndefined();
      expect(lastJson().error).toBe("Internal server error");
      expect(lastJson().code).toBe("INTERNAL_ERROR");
    });

    it("exposes the real code, message, and details in development", () => {
      process.env.NODE_ENV = "development";
      sendInternalError(mockRes, "DB_ERROR", "Query timeout", {
        details: { query: "SELECT * FROM users" },
      });

      expect(lastJson().details).toBeDefined();
      expect(lastJson().error).toBe("Query timeout");
      expect(lastJson().code).toBe("DB_ERROR");
    });

    it("masks every internal code to INTERNAL_ERROR in production", () => {
      process.env.NODE_ENV = "production";
      sendInternalError(mockRes, "CONFIGURATION_ERROR", "Invalid config");

      expect(lastJson().code).toBe("INTERNAL_ERROR");
    });

    it("shows the actual internal code in development", () => {
      process.env.NODE_ENV = "development";
      sendInternalError(mockRes, "CONFIGURATION_ERROR", "Invalid config");

      expect(lastJson().code).toBe("CONFIGURATION_ERROR");
    });

    it("rejects a public code passed as internal", () => {
      expect(() => {
        sendInternalError(mockRes, "NOT_FOUND" as never, "Should fail");
      }).toThrow(/Invalid internal error code/);
    });

    it("maps each internal code to the correct HTTP status", () => {
      const cases: Array<[string, number]> = [
        ["DB_ERROR", 500],
        ["INTERNAL_ERROR", 500],
        ["SERVICE_UNAVAILABLE", 503],
        ["CONFIGURATION_ERROR", 503],
        ["FEATURE_FLAG_EVALUATION_ERROR", 500],
      ];

      cases.forEach(([code, expectedStatus]) => {
        mockRes = createMockResponse();
        sendInternalError(mockRes, code as never, "Test error");
        expect(mockRes.status).toHaveBeenCalledWith(expectedStatus);
      });
    });
  });

  describe("sendError (generic)", () => {
    it("routes public codes to the public envelope", () => {
      sendError(mockRes, "NOT_FOUND", "Not found");

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(lastJson().code).toBe("NOT_FOUND");
    });

    it("routes internal codes to the internal envelope", () => {
      sendError(mockRes, "DB_ERROR", "Database failed");

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(["DB_ERROR", "INTERNAL_ERROR"]).toContain(lastJson().code);
    });

    it("masks internal codes in production", () => {
      process.env.NODE_ENV = "production";
      sendError(mockRes, "DB_ERROR", "Database failed");

      expect(lastJson().code).toBe("INTERNAL_ERROR");
      expect(lastJson().details).toBeUndefined();
    });

    it("rejects unknown codes", () => {
      expect(() => {
        sendError(mockRes, "UNKNOWN_CODE" as never, "Unknown");
      }).toThrow(/Unknown error code/);
    });

    it("propagates options to the appropriate sender", () => {
      const options: SendErrorOptions = {
        locale: "es",
        details: { field: "email" },
      };

      sendError(mockRes, "BAD_REQUEST", "Invalid input", options);

      expect(lastJson().details).toEqual({ field: "email" });
    });
  });

  describe("sendErrorResponse (legacy AppError envelope)", () => {
    it("emits the canonical AppError envelope", () => {
      const err = new ValidationError("Invalid input", { field: "name" });
      sendErrorResponse(mockRes, err);

      expect(mockRes.status).toHaveBeenCalledWith(err.statusCode);
      expect(lastJson().code).toBe("VALIDATION_ERROR");
      expect(lastJson().details).toEqual({ field: "name" });
      expect(lastJson().success).toBe(false);
    });

    it("attaches the request id when the request carries one", () => {
      const err = new NotFoundError("Resource not found");
      const mockReq = { requestId: "req-123", id: "backup-id" } as never;

      sendErrorResponse(mockRes, err, mockReq as never);

      expect(lastJson().requestId).toBe("req-123");
    });

    it("falls back to the request id when requestId is absent", () => {
      const err = new NotFoundError();
      const mockReq = { id: "backup-id" } as never;

      sendErrorResponse(mockRes, err, mockReq as never);

      expect(lastJson().requestId).toBe("backup-id");
    });

    it("omits requestId when no request is supplied", () => {
      const err = new NotFoundError();

      sendErrorResponse(mockRes, err);

      expect(lastJson().requestId).toBeUndefined();
    });

    it("emits internal AppError codes as-is (masking is the caller's concern)", () => {
      const err = new DatabaseError("query failed", { sql: "SELECT 1" });
      sendErrorResponse(mockRes, err);

      expect(lastJson().code).toBe("DB_ERROR");
      expect(lastJson().details).toEqual({ sql: "SELECT 1" });
    });
  });

  describe("i18n message resolution", () => {
    it("resolves Spanish messages for public errors", () => {
      sendPublicError(mockRes, "VALIDATION_ERROR", "Test", { locale: "es" });

      expect(typeof lastJson().message).toBe("string");
      expect(lastJson().message.length).toBeGreaterThan(0);
      expect(lastJson().message).not.toBe("errors.validation.validation_error");
    });

    it("resolves Spanish messages for internal errors", () => {
      sendInternalError(mockRes, "DB_ERROR", "Test", { locale: "es" });

      expect(typeof lastJson().message).toBe("string");
      expect(lastJson().message).not.toBe("errors.internal.db_error");
    });

    it("falls back to the key itself for an unsupported locale value", () => {
      sendPublicError(mockRes, "NOT_FOUND", "Test", {
        locale: "unsupported" as never,
      });

      expect(typeof lastJson().message).toBe("string");
    });
  });

  describe("Response shape and security", () => {
    it("always includes success:false, timestamp, code, and message", () => {
      sendPublicError(mockRes, "BAD_REQUEST", "Test");

      expect(lastJson().success).toBe(false);
      expect(lastJson().code).toBe("BAD_REQUEST");
      expect(typeof lastJson().timestamp).toBe("string");
      expect(new Date(lastJson().timestamp as string).getTime()).toBeGreaterThan(0);
      expect(lastJson().message).toBeDefined();
    });

    it("omits details when none are supplied", () => {
      sendPublicError(mockRes, "BAD_REQUEST", "Test");

      expect(lastJson().details).toBeUndefined();
    });

    it("does not leak internal details in production", () => {
      process.env.NODE_ENV = "production";
      const sensitiveDetails = {
        sql: "SELECT * FROM users WHERE id=1",
        stack: "Error at line 42",
        env: "DATABASE_URL=secret",
      };

      sendInternalError(mockRes, "DB_ERROR", "DB failed", {
        details: sensitiveDetails,
      });

      expect(lastJson().details).toBeUndefined();
    });

    it("rejects unknown codes at runtime in every sender", () => {
      expect(() => sendError(mockRes, "HACKER_INJECTION" as never, "Attempt")).toThrow();
      expect(() => sendInternalError(mockRes, "HACKER_INJECTION" as never, "Attempt")).toThrow(
        /Unknown error code/,
      );
      expect(() => sendPublicError(mockRes, "HACKER_INJECTION" as never, "Attempt")).toThrow(
        /Unknown error code/,
      );
    });
  });

  describe("AppError interop", () => {
    it("sendErrorResponse accepts InternalServerError and emits 500", () => {
      const err = new InternalServerError("boom");
      sendErrorResponse(mockRes, err);
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(lastJson().code).toBe("INTERNAL_ERROR");
    });
  });
});
