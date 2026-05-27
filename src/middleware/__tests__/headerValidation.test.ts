import { Request, Response, NextFunction } from "express";
import {
  validateIdempotencyKey,
  validateRequestId,
  validateWebhookSignature,
  hasNoInjectionChars,
  validateIdempotencyKeyHeader,
  validateRequestIdHeader,
  validateWebhookSignatureHeader,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  REQUEST_ID_MAX_LENGTH,
  WEBHOOK_SIGNATURE_MAX_LENGTH,
} from "../headerValidation";

describe("Header Validation Pure Functions", () => {
  describe("validateIdempotencyKey", () => {
    it("should accept a valid idempotency key", () => {
      const result = validateIdempotencyKey("abc-123_XYZ.99");
      expect(result.valid).toBe(true);
    });

    it("should reject missing or undefined values", () => {
      expect(validateIdempotencyKey(undefined).valid).toBe(false);
      expect(validateIdempotencyKey(undefined).reason).toContain("missing");
    });

    it("should reject non-string values passed as any", () => {
      expect(validateIdempotencyKey(12345 as any).valid).toBe(false);
      expect(validateIdempotencyKey(12345 as any).reason).toContain("must be a string");
    });

    it("should reject empty values", () => {
      expect(validateIdempotencyKey("").valid).toBe(false);
      expect(validateIdempotencyKey("").reason).toContain("must not be empty");
    });

    it("should reject whitespace-only values", () => {
      expect(validateIdempotencyKey("   ").valid).toBe(false);
      expect(validateIdempotencyKey("   ").reason).toContain("invalid characters");
    });

    it("should reject oversized values", () => {
      const oversized = "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1);
      const result = validateIdempotencyKey(oversized);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("exceeds maximum length");
    });

    it("should reject disallowed special characters", () => {
      expect(validateIdempotencyKey("key$123").valid).toBe(false);
      expect(validateIdempotencyKey("key#123").valid).toBe(false);
    });
  });

  describe("validateRequestId", () => {
    it("should accept a valid request ID including colons", () => {
      const result = validateRequestId("req:namespace:123-abc_XYZ.45");
      expect(result.valid).toBe(true);
    });

    it("should reject missing, empty, or whitespace values", () => {
      expect(validateRequestId(undefined).valid).toBe(false);
      expect(validateRequestId("").valid).toBe(false);
      expect(validateRequestId("   ").valid).toBe(false);
    });

    it("should reject non-string values", () => {
      expect(validateRequestId(true as any).valid).toBe(false);
    });

    it("should reject oversized request IDs", () => {
      const oversized = "b".repeat(REQUEST_ID_MAX_LENGTH + 1);
      const result = validateRequestId(oversized);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("exceeds maximum length");
    });
  });

  describe("validateWebhookSignature", () => {
    it("should accept valid hex signatures with or without the sha256 prefix", () => {
      const validHex = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      expect(validateWebhookSignature(validHex).valid).toBe(true);
      expect(validateWebhookSignature(`sha256=${validHex}`).valid).toBe(true);
    });

    it("should reject non-hex signature characters", () => {
      expect(validateWebhookSignature("sha256=nothexghijklmnopqrstuvwxyz").valid).toBe(false);
    });

    it("should reject missing or empty signature values", () => {
      expect(validateWebhookSignature(undefined).valid).toBe(false);
      expect(validateWebhookSignature("").valid).toBe(false);
    });

    it("should reject non-string signatures", () => {
      expect(validateWebhookSignature({} as any).valid).toBe(false);
    });

    it("should reject oversized signature values", () => {
      const oversized = "a".repeat(WEBHOOK_SIGNATURE_MAX_LENGTH + 1);
      const result = validateWebhookSignature(oversized);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("exceeds maximum length");
    });
  });

  describe("hasNoInjectionChars", () => {
    it("should return true for valid safe inputs", () => {
      expect(hasNoInjectionChars("safe-string")).toBe(true);
      expect(hasNoInjectionChars("safe\tstring-with-tab")).toBe(true);
    });

    it("should detect and reject null bytes", () => {
      expect(hasNoInjectionChars("unsafe\0string")).toBe(false);
    });

    it("should detect and reject CRLF line breaks", () => {
      expect(hasNoInjectionChars("line\rbreak")).toBe(false);
      expect(hasNoInjectionChars("line\nbreak")).toBe(false);
    });

    it("should detect and reject ASCII control characters", () => {
      expect(hasNoInjectionChars("control\x01char")).toBe(false);
      expect(hasNoInjectionChars("control\x7Fchar")).toBe(false);
    });
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
      }),
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    nextFunction = jest.fn();
  });

  describe("validateIdempotencyKeyHeader", () => {
    it("should skip validation if the header is absent", () => {
      validateIdempotencyKeyHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalled();
    });

    it("should proceed if the header is valid", () => {
      mockRequest.headers!["idempotency-key"] = "valid-key-123";
      validateIdempotencyKeyHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalled();
    });

    it("should return 400 bad request if the header is empty or malformed", () => {
      mockRequest.headers!["idempotency-key"] = "   "; // Whitespace/empty rejection
      validateIdempotencyKeyHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false })
      );
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("should handle duplicate header arrays gracefully by treating them as invalid strings", () => {
      // Express can sometimes parse duplicate headers as an array of strings
      mockRequest.headers!["idempotency-key"] = ["key1", "key2"] as any;
      validateIdempotencyKeyHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(nextFunction).not.toHaveBeenCalled();
    });
  });

  describe("validateRequestIdHeader", () => {
    it("should skip validation if the header is absent", () => {
      validateRequestIdHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalled();
    });

    it("should proceed if the header is valid", () => {
      mockRequest.headers!["x-request-id"] = "valid:req:id";
      validateRequestIdHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalled();
    });

    it("should return 400 bad request if the header is invalid or oversized", () => {
      mockRequest.headers!["x-request-id"] = "a".repeat(REQUEST_ID_MAX_LENGTH + 1);
      validateRequestIdHeader(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(nextFunction).not.toHaveBeenCalled();
    });
  });

  describe("validateWebhookSignatureHeader", () => {
    it("should return 400 bad request if mandatory webhook signature is absent", () => {
      const middleware = validateWebhookSignatureHeader();
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(nextFunction).not.toHaveBeenCalled();
    });

    it("should proceed if mandatory webhook signature is present and valid", () => {
      const middleware = validateWebhookSignatureHeader("x-custom-sig");
      mockRequest.headers!["x-custom-sig"] = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      middleware(mockRequest as Request, mockResponse as Response, nextFunction);
      expect(nextFunction).toHaveBeenCalled();
    });
  });
});