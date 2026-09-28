import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  REQUEST_ID_MAX_LENGTH,
  WEBHOOK_SIGNATURE_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  REQUEST_ID_PATTERN,
  WEBHOOK_SIGNATURE_PATTERN,
  validateIdempotencyKey,
  validateRequestId,
  validateWebhookSignature,
  hasNoInjectionChars,
  validateIdempotencyKeyHeader,
  validateRequestIdHeader,
  validateWebhookSignatureHeader,
  type HeaderValidationResult,
} from "../headerValidation.js";

describe("Header Validation Constants", () => {
  it("exposes expected maximum length limits", () => {
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(255);
    expect(REQUEST_ID_MAX_LENGTH).toBe(128);
    expect(WEBHOOK_SIGNATURE_MAX_LENGTH).toBe(512);
  });

  it("exposes validation regex patterns", () => {
    expect(IDEMPOTENCY_KEY_PATTERN).toBeInstanceOf(RegExp);
    expect(REQUEST_ID_PATTERN).toBeInstanceOf(RegExp);
    expect(WEBHOOK_SIGNATURE_PATTERN).toBeInstanceOf(RegExp);
  });
});

describe("validateIdempotencyKey", () => {
  describe("success paths and boundaries", () => {
    it("accepts valid alphanumeric idempotency keys with allowed delimiters", () => {
      const keys = ["valid-key", "valid_key_123", "valid.key.456", "abc-XYZ_123.789", "A", "0"];
      for (const key of keys) {
        const result: HeaderValidationResult = validateIdempotencyKey(key);
        expect(result.valid).toBe(true);
        expect(result.reason).toBeUndefined();
      }
    });

    it("accepts idempotency key at exact maximum length boundary (255 characters)", () => {
      const maxKey = "k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH);
      expect(maxKey.length).toBe(255);
      const result = validateIdempotencyKey(maxKey);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe("failure paths and invalid inputs", () => {
    it("rejects undefined or null values with missing reason", () => {
      const undefinedRes = validateIdempotencyKey(undefined);
      expect(undefinedRes.valid).toBe(false);
      expect(undefinedRes.reason).toBe("Idempotency-Key header is missing");

      const nullRes = validateIdempotencyKey(null as any);
      expect(nullRes.valid).toBe(false);
      expect(nullRes.reason).toBe("Idempotency-Key header is missing");
    });

    it("rejects non-string values passed as any", () => {
      const nonStrings = [12345, true, {}, [], () => {}];
      for (const val of nonStrings) {
        const result = validateIdempotencyKey(val as any);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe("Idempotency-Key must be a string");
      }
    });

    it("rejects empty string values", () => {
      const result = validateIdempotencyKey("");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("Idempotency-Key must not be empty");
    });

    it("rejects keys exceeding IDEMPOTENCY_KEY_MAX_LENGTH (256 characters)", () => {
      const oversized = "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1);
      expect(oversized.length).toBe(256);
      const result = validateIdempotencyKey(oversized);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe(
        `Idempotency-Key exceeds maximum length of ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
      );
    });

    it("rejects whitespace and invalid special characters", () => {
      const invalidKeys = [
        "   ",
        "key with space",
        "key$123",
        "key#123",
        "key@123",
        "key!123",
        "key:123", // colon not allowed in idempotency key
        "key/123",
        "key\n123",
        "key\x00123",
        "key🌟123",
      ];
      for (const key of invalidKeys) {
        const result = validateIdempotencyKey(key);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe(
          "Idempotency-Key contains invalid characters. " +
            "Allowed: alphanumerics, hyphens (-), underscores (_), and dots (.)",
        );
      }
    });
  });
});

describe("validateRequestId", () => {
  describe("success paths and boundaries", () => {
    it("accepts valid request IDs with colons, dots, underscores, and hyphens", () => {
      const ids = [
        "req:namespace:123-abc_XYZ.45",
        "c2f63aa7-bbba-4802-a677-4fc27f800caf",
        "api:v1:req.99",
        "R",
      ];
      for (const id of ids) {
        const result: HeaderValidationResult = validateRequestId(id);
        expect(result.valid).toBe(true);
        expect(result.reason).toBeUndefined();
      }
    });

    it("accepts request ID at exact maximum length boundary (128 characters)", () => {
      const maxId = "r".repeat(REQUEST_ID_MAX_LENGTH);
      expect(maxId.length).toBe(128);
      const result = validateRequestId(maxId);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe("failure paths and invalid inputs", () => {
    it("rejects undefined or null request ID", () => {
      expect(validateRequestId(undefined).valid).toBe(false);
      expect(validateRequestId(undefined).reason).toBe("X-Request-Id header is missing");

      expect(validateRequestId(null as any).valid).toBe(false);
      expect(validateRequestId(null as any).reason).toBe("X-Request-Id header is missing");
    });

    it("rejects non-string values", () => {
      const nonStrings = [100, false, { id: "123" }, ["req"]];
      for (const val of nonStrings) {
        const result = validateRequestId(val as any);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe("X-Request-Id must be a string");
      }
    });

    it("rejects empty string", () => {
      const result = validateRequestId("");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("X-Request-Id must not be empty");
    });

    it("rejects request IDs exceeding REQUEST_ID_MAX_LENGTH (129 characters)", () => {
      const oversized = "b".repeat(REQUEST_ID_MAX_LENGTH + 1);
      expect(oversized.length).toBe(129);
      const result = validateRequestId(oversized);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe(
        `X-Request-Id exceeds maximum length of ${REQUEST_ID_MAX_LENGTH} characters`,
      );
    });

    it("rejects whitespace and disallowed characters", () => {
      const invalidIds = [
        "   ",
        "req id with space",
        "req;123",
        "req/123",
        "req?123",
        "req#123",
        "req\r\n123",
      ];
      for (const id of invalidIds) {
        const result = validateRequestId(id);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe(
          "X-Request-Id contains invalid characters. " +
            "Allowed: alphanumerics, hyphens (-), underscores (_), colons (:), and dots (.)",
        );
      }
    });
  });
});

describe("validateWebhookSignature", () => {
  describe("success paths and boundaries", () => {
    it("accepts valid hex signatures with or without sha256= prefix", () => {
      const hex64 = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      expect(validateWebhookSignature(hex64).valid).toBe(true);
      expect(validateWebhookSignature(`sha256=${hex64}`).valid).toBe(true);
      expect(validateWebhookSignature("A1B2C3D4E5F6").valid).toBe(true);
      expect(validateWebhookSignature("sha256=A1B2C3D4E5F6").valid).toBe(true);
      expect(validateWebhookSignature("f").valid).toBe(true);
    });

    it("accepts webhook signature at exact maximum length boundary (512 characters)", () => {
      const maxHex = "a".repeat(WEBHOOK_SIGNATURE_MAX_LENGTH);
      expect(maxHex.length).toBe(512);
      const result = validateWebhookSignature(maxHex);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe("failure paths and invalid inputs", () => {
    it("rejects undefined or null webhook signature", () => {
      expect(validateWebhookSignature(undefined).valid).toBe(false);
      expect(validateWebhookSignature(undefined).reason).toBe(
        "Webhook signature header is missing",
      );

      expect(validateWebhookSignature(null as any).valid).toBe(false);
      expect(validateWebhookSignature(null as any).reason).toBe(
        "Webhook signature header is missing",
      );
    });

    it("rejects non-string values", () => {
      const nonStrings = [9999, true, {}, ["sha256"]];
      for (const val of nonStrings) {
        const result = validateWebhookSignature(val as any);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe("Webhook signature must be a string");
      }
    });

    it("rejects empty signature strings", () => {
      const result = validateWebhookSignature("");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("Webhook signature must not be empty");
    });

    it("rejects signatures exceeding WEBHOOK_SIGNATURE_MAX_LENGTH (513 characters)", () => {
      const oversized = "a".repeat(WEBHOOK_SIGNATURE_MAX_LENGTH + 1);
      expect(oversized.length).toBe(513);
      const result = validateWebhookSignature(oversized);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe(
        `Webhook signature exceeds maximum length of ${WEBHOOK_SIGNATURE_MAX_LENGTH} characters`,
      );
    });

    it("rejects invalid non-hex characters and malformed prefixes", () => {
      const invalidSigs = [
        "sha256=nothexghijklmnopqrstuvwxyz",
        "sha512=a1b2c3d4",
        "hmac=a1b2c3d4",
        "sha256=",
        "   ",
        "a1b2c3d4-e5f6",
        "a1b2 c3d4",
      ];
      for (const sig of invalidSigs) {
        const result = validateWebhookSignature(sig);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe(
          "Webhook signature contains invalid characters. " +
            'Expected hex digits, optionally prefixed with "sha256="',
        );
      }
    });
  });
});

describe("hasNoInjectionChars", () => {
  it("returns true for safe string inputs", () => {
    expect(hasNoInjectionChars("safe-string_123.v1")).toBe(true);
    expect(hasNoInjectionChars("safe\twith\ttabs")).toBe(true);
    expect(hasNoInjectionChars("")).toBe(true);
  });

  it("detects and rejects null bytes", () => {
    expect(hasNoInjectionChars("unsafe\0payload")).toBe(false);
    expect(hasNoInjectionChars("\0")).toBe(false);
  });

  it("detects and rejects carriage return (CR) and line feed (LF)", () => {
    expect(hasNoInjectionChars("line\rbreak")).toBe(false);
    expect(hasNoInjectionChars("line\nbreak")).toBe(false);
    expect(hasNoInjectionChars("line\r\nbreak")).toBe(false);
  });

  it("detects and rejects ASCII control characters", () => {
    // 0x01 (SOH), 0x08 (BS), 0x0B (VT), 0x1F (US), 0x7F (DEL)
    expect(hasNoInjectionChars("control\x01test")).toBe(false);
    expect(hasNoInjectionChars("control\x08test")).toBe(false);
    expect(hasNoInjectionChars("control\x0btest")).toBe(false);
    expect(hasNoInjectionChars("control\x1ftest")).toBe(false);
    expect(hasNoInjectionChars("control\x7ftest")).toBe(false);
  });
});

describe("Header Validation Express Middleware", () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction;

  beforeEach(() => {
    mockRequest = {
      headers: {},
      header: jest.fn((name: string) => {
        return (mockRequest.headers as any)[name.toLowerCase()];
      }) as any,
    };
    mockResponse = {
      status: jest.fn().mockReturnThis() as any,
      json: jest.fn().mockReturnThis() as any,
    };
    nextFunction = jest.fn();
  });

  describe("validateIdempotencyKeyHeader", () => {
    it("skips validation and calls next() when header is absent (opt-in)", () => {
      validateIdempotencyKeyHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("proceeds with next() when header is present and valid", () => {
      mockRequest.headers!["idempotency-key"] = "valid-key-123_abc.01";
      validateIdempotencyKeyHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("returns 400 Bad Request with error reason when header is empty or malformed", () => {
      mockRequest.headers!["idempotency-key"] = "invalid$key";
      validateIdempotencyKeyHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining("invalid characters"),
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("returns 400 Bad Request when header exceeds IDEMPOTENCY_KEY_MAX_LENGTH", () => {
      mockRequest.headers!["idempotency-key"] = "x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1);
      validateIdempotencyKeyHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: `Idempotency-Key exceeds maximum length of ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("returns 400 Bad Request when header is an array of strings (duplicate headers)", () => {
      mockRequest.headers!["idempotency-key"] = ["key1", "key2"] as any;
      validateIdempotencyKeyHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: "Idempotency-Key must be a string",
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });
  });

  describe("validateRequestIdHeader", () => {
    it("skips validation and calls next() when header is absent (optional)", () => {
      validateRequestIdHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("proceeds with next() when header is present and valid", () => {
      mockRequest.headers!["x-request-id"] = "trace:req-123.abc";
      validateRequestIdHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("returns 400 Bad Request when header exceeds REQUEST_ID_MAX_LENGTH", () => {
      mockRequest.headers!["x-request-id"] = "r".repeat(REQUEST_ID_MAX_LENGTH + 1);
      validateRequestIdHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: `X-Request-Id exceeds maximum length of ${REQUEST_ID_MAX_LENGTH} characters`,
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("returns 400 Bad Request when header has invalid characters", () => {
      mockRequest.headers!["x-request-id"] = "bad req id";
      validateRequestIdHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining("invalid characters"),
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });
  });

  describe("validateWebhookSignatureHeader", () => {
    it("returns 400 Bad Request when default header (X-Webhook-Signature) is absent", () => {
      const middleware = validateWebhookSignatureHeader();
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: "Webhook signature header is missing",
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("proceeds with next() when default header is present and valid", () => {
      const middleware = validateWebhookSignatureHeader();
      mockRequest.headers!["x-webhook-signature"] =
        "sha256=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("inspects customized header name and succeeds when valid", () => {
      const middleware = validateWebhookSignatureHeader("X-Hub-Signature-256");
      mockRequest.headers!["x-hub-signature-256"] =
        "sha256=1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalledTimes(1);
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it("returns 400 Bad Request when custom signature header is invalid", () => {
      const middleware = validateWebhookSignatureHeader("X-Hub-Signature-256");
      mockRequest.headers!["x-hub-signature-256"] = "sha256=nothex";
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining("invalid characters"),
      });
      expect(nextFunction).not.toHaveBeenCalled();
    });
  });
});
