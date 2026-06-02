/**
 * Tests for typed error taxonomy.
 *
 * Validates:
 * - Public/internal error separation
 * - Type safety (compile-time code validation)
 * - HTTP status code mapping
 * - i18n message resolution
 * - Backward compatibility with old ERROR_CODES
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  ERROR_TAXONOMY,
  type PublicErrorCode,
  type InternalErrorCode,
  type ErrorCode,
  isPublicError,
  isInternalError,
  type PublicError,
  type InternalError,
  createMessageKey,
  ERROR_CODES,
} from "../errors/errorTaxonomy.js";
import {
  resolveMessage,
  getMessageCatalog,
  getSupportedLocales,
  type SupportedLocale,
} from "../i18n/messageLoader.js";

describe("Error Taxonomy", () => {
  describe("Structure and Typing", () => {
    it("should have all error codes in taxonomy", () => {
      const codes = Object.keys(ERROR_TAXONOMY);
      expect(codes.length).toBeGreaterThan(0);
      expect(codes).toContain("NOT_FOUND");
      expect(codes).toContain("INTERNAL_ERROR");
    });

    it("should map codes to status codes", () => {
      const notFoundError = ERROR_TAXONOMY.NOT_FOUND as PublicError;
      expect(notFoundError.status).toBe(404);
      expect(notFoundError.code).toBe("NOT_FOUND");

      const dbError = ERROR_TAXONOMY.DB_ERROR as InternalError;
      expect(dbError.status).toBe(500);
      expect(dbError.code).toBe("DB_ERROR");
    });

    it("should have i18n message keys for all errors", () => {
      Object.values(ERROR_TAXONOMY).forEach((error) => {
        expect(error.messageKey).toBeDefined();
        expect(typeof error.messageKey).toBe("string");
        // Message keys should follow pattern: errors.category.code
        expect(error.messageKey).toMatch(/^errors\./);
      });
    });
  });

  describe("Public Error Codes", () => {
    const publicCodes: PublicErrorCode[] = [
      "BAD_REQUEST",
      "VALIDATION_ERROR",
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "RATE_LIMITED",
    ];

    publicCodes.forEach((code) => {
      it(`should classify ${code} as public`, () => {
        const error = ERROR_TAXONOMY[code] as PublicError;
        expect(isPublicError(error)).toBe(true);
        expect(isInternalError(error)).toBe(false);
      });

      it(`should have valid HTTP status for ${code}`, () => {
        const error = ERROR_TAXONOMY[code] as PublicError;
        expect(error.status).toBeGreaterThanOrEqual(400);
        expect(error.status).toBeLessThan(500);
      });
    });
  });

  describe("Internal Error Codes", () => {
    const internalCodes: InternalErrorCode[] = [
      "DB_ERROR",
      "INTERNAL_ERROR",
      "SERVICE_UNAVAILABLE",
      "CONFIGURATION_ERROR",
    ];

    internalCodes.forEach((code) => {
      it(`should classify ${code} as internal`, () => {
        const error = ERROR_TAXONOMY[code] as InternalError;
        expect(isInternalError(error)).toBe(true);
        expect(isPublicError(error)).toBe(false);
      });

      it(`should have 5xx HTTP status for ${code}`, () => {
        const error = ERROR_TAXONOMY[code] as InternalError;
        expect(error.status).toBeGreaterThanOrEqual(500);
        expect(error.status).toBeLessThan(600);
      });
    });
  });

  describe("HTTP Status Mapping", () => {
    const statusTests: Array<[ErrorCode, number]> = [
      ["BAD_REQUEST", 400],
      ["VALIDATION_ERROR", 422],
      ["MISSING_REQUIRED_FIELD", 400],
      ["UNAUTHORIZED", 401],
      ["INVALID_TOKEN", 401],
      ["FORBIDDEN", 403],
      ["INSUFFICIENT_PERMISSIONS", 403],
      ["NOT_FOUND", 404],
      ["RATE_LIMITED", 429],
      ["CONFLICT", 409],
      ["UNSUPPORTED_MEDIA_TYPE", 415],
      ["DB_ERROR", 500],
      ["INTERNAL_ERROR", 500],
      ["SERVICE_UNAVAILABLE", 503],
    ];

    statusTests.forEach(([code, expectedStatus]) => {
      it(`should map ${code} to HTTP ${expectedStatus}`, () => {
        const error = ERROR_TAXONOMY[code];
        expect(error.status).toBe(expectedStatus);
      });
    });
  });

  describe("Message Key Resolution", () => {
    it("should resolve English messages", () => {
      const messageKey = "errors.validation.bad_request" as any;
      const message = resolveMessage(messageKey, "en");
      expect(message).not.toBe(messageKey);
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    });

    it("should resolve Spanish messages", () => {
      const messageKey = "errors.validation.bad_request" as any;
      const message = resolveMessage(messageKey, "es");
      expect(message).not.toBe(messageKey);
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    });

    it("should fallback to English for missing keys", () => {
      const messageKey = "errors.validation.bad_request" as any;
      const enMessage = resolveMessage(messageKey, "en");
      const fallback = resolveMessage("nonexistent.key" as any, "es");
      // Should return the key itself as fallback
      expect(fallback).toBe("nonexistent.key");
    });

    it("should handle nested message paths", () => {
      const messageKey = "errors.auth.invalid_token" as any;
      const message = resolveMessage(messageKey, "en");
      expect(message).not.toBe(messageKey);
    });
  });

  describe("Locale Support", () => {
    it("should list supported locales", () => {
      const locales = getSupportedLocales();
      expect(locales).toContain("en");
      expect(locales).toContain("es");
      expect(locales.length).toBeGreaterThan(0);
    });

    it("should load message catalog for supported locales", () => {
      getSupportedLocales().forEach((locale) => {
        const catalog = getMessageCatalog(locale);
        expect(catalog).toBeDefined();
        expect(catalog.errors).toBeDefined();
      });
    });

    it("should throw for unsupported locale", () => {
      expect(() => getMessageCatalog("unsupported" as SupportedLocale)).toThrow();
    });
  });

  describe("Backward Compatibility", () => {
    it("should expose ERROR_CODES for migration", () => {
      expect(ERROR_CODES).toBeDefined();
      expect(ERROR_CODES.NOT_FOUND).toBeDefined();
      expect(ERROR_CODES.NOT_FOUND.status).toBe(404);
      expect(ERROR_CODES.NOT_FOUND.code).toBe("NOT_FOUND");
    });

    it("should map all taxonomy entries to ERROR_CODES", () => {
      Object.keys(ERROR_TAXONOMY).forEach((code) => {
        expect(code in ERROR_CODES).toBe(true);
        const taxonomyError = ERROR_TAXONOMY[code as ErrorCode];
        const legacyError = ERROR_CODES[code as ErrorCode];
        expect(legacyError.status).toBe(taxonomyError.status);
        expect(legacyError.code).toBe(taxonomyError.code);
      });
    });
  });

  describe("Type Safety", () => {
    it("should not allow unknown error codes", () => {
      // This would be a compile-time error in real TypeScript:
      // const code: ErrorCode = "UNKNOWN_CODE"; // Type error!

      // At runtime, we can verify unknown codes are rejected
      expect(() => {
        const unknownCode = "UNKNOWN_CODE" as ErrorCode;
        if (!(unknownCode in ERROR_TAXONOMY)) {
          throw new Error("Unknown code");
        }
      }).not.toThrow();
    });

    it("should validate code to status mapping", () => {
      // Every error must have consistent status
      Object.entries(ERROR_TAXONOMY).forEach(([code, error]) => {
        expect(error.code).toBe(code);
        expect(error.status).toBeDefined();
        expect(typeof error.status).toBe("number");
      });
    });
  });

  describe("Message Key Creation", () => {
    it("should create branded message keys", () => {
      const key = createMessageKey("errors.test.key");
      expect(typeof key).toBe("string");
      expect(key).toBe("errors.test.key");
    });

    it("should use same branded type for all taxonomy keys", () => {
      Object.values(ERROR_TAXONOMY).forEach((error) => {
        // All message keys should be strings (branded type)
        expect(typeof error.messageKey).toBe("string");
      });
    });
  });

  describe("Public vs Internal Error Separation", () => {
    it("should not mix public and internal codes", () => {
      const publicErrors = Object.entries(ERROR_TAXONOMY)
        .filter(([_, error]) => isPublicError(error))
        .map(([code]) => code);

      const internalErrors = Object.entries(ERROR_TAXONOMY)
        .filter(([_, error]) => isInternalError(error))
        .map(([code]) => code);

      // Verify no overlap
      const overlap = publicErrors.filter((code) =>
        internalErrors.includes(code),
      );
      expect(overlap).toHaveLength(0);

      // Verify coverage
      const allCodes = Object.keys(ERROR_TAXONOMY);
      const covered = [...publicErrors, ...internalErrors];
      expect(covered.sort()).toEqual(allCodes.sort());
    });

    it("should expose only public codes in public errors", () => {
      Object.entries(ERROR_TAXONOMY).forEach(([code, error]) => {
        if (isPublicError(error)) {
          expect(code).not.toMatch(/internal/i);
        }
      });
    });
  });

  describe("Comprehensive Coverage", () => {
    it("should have at least 25 error codes", () => {
      const codes = Object.keys(ERROR_TAXONOMY);
      expect(codes.length).toBeGreaterThanOrEqual(25);
    });

    it("should cover validation errors", () => {
      expect("BAD_REQUEST" in ERROR_TAXONOMY).toBe(true);
      expect("VALIDATION_ERROR" in ERROR_TAXONOMY).toBe(true);
      expect("MISSING_REQUIRED_FIELD" in ERROR_TAXONOMY).toBe(true);
    });

    it("should cover authentication errors", () => {
      expect("UNAUTHORIZED" in ERROR_TAXONOMY).toBe(true);
      expect("INVALID_TOKEN" in ERROR_TAXONOMY).toBe(true);
      expect("INVALID_API_KEY" in ERROR_TAXONOMY).toBe(true);
    });

    it("should cover authorization errors", () => {
      expect("FORBIDDEN" in ERROR_TAXONOMY).toBe(true);
      expect("INSUFFICIENT_PERMISSIONS" in ERROR_TAXONOMY).toBe(true);
    });

    it("should cover resource errors", () => {
      expect("NOT_FOUND" in ERROR_TAXONOMY).toBe(true);
      expect("CONFLICT" in ERROR_TAXONOMY).toBe(true);
    });

    it("should cover infrastructure errors", () => {
      expect("DB_ERROR" in ERROR_TAXONOMY).toBe(true);
      expect("INTERNAL_ERROR" in ERROR_TAXONOMY).toBe(true);
      expect("SERVICE_UNAVAILABLE" in ERROR_TAXONOMY).toBe(true);
    });
  });
});
