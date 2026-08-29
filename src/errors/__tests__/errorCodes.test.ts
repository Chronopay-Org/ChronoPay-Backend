/**
 * Tests for the typed error code taxonomy.
 *
 * Validates:
 * - the discriminated public/internal split
 * - HTTP status mapping and i18n message keys for every code
 * - backward compatibility with the legacy `ERROR_CODES` surface
 * - runtime type guards and no public/internal overlap
 */

import { describe, it, expect } from "@jest/globals";
import {
  ERROR_TAXONOMY,
  ERROR_CODES,
  PUBLIC_ERROR_CODES,
  INTERNAL_ERROR_CODES,
  createMessageKey,
  isPublicError,
  isInternalError,
  type ErrorCode,
  type ErrorType,
  type InternalError,
  type PublicError,
} from "../errorCodes.js";
import {
  getMessageCatalog,
  getSupportedLocales,
  resolveMessage,
  type SupportedLocale,
} from "../../i18n/messageLoader.js";

describe("Error Code Taxonomy", () => {
  describe("Structure and typing", () => {
    it("lists every error code in the taxonomy", () => {
      const codes = Object.keys(ERROR_TAXONOMY);
      expect(codes.length).toBeGreaterThanOrEqual(30);
      expect(codes).toContain("NOT_FOUND");
      expect(codes).toContain("INTERNAL_ERROR");
      expect(codes).toContain("BUNDLE_EXPIRED");
      expect(codes).toContain("QUERY_BUDGET_EXCEEDED");
    });

    it("maps every code to the correct HTTP status and code string", () => {
      Object.entries(ERROR_TAXONOMY).forEach(([code, entry]) => {
        expect(entry.code).toBe(code);
        expect(typeof entry.status).toBe("number");
        expect(entry.status).toBeGreaterThanOrEqual(400);
        expect(entry.status).toBeLessThan(600);
      });
    });

    it("gives every code a well-formed i18n message key", () => {
      Object.values(ERROR_TAXONOMY).forEach((entry) => {
        expect(entry.messageKey).toBeDefined();
        expect(typeof entry.messageKey).toBe("string");
        expect(entry.messageKey).toMatch(/^errors\.[a-z0-9_.]+$/);
      });
    });

    it("declares runtime arrays covering every taxonomy key exactly once", () => {
      const publicSet = new Set(PUBLIC_ERROR_CODES);
      const internalSet = new Set(INTERNAL_ERROR_CODES);
      Object.keys(ERROR_TAXONOMY).forEach((code) => {
        expect(publicSet.has(code as ErrorCode) || internalSet.has(code as ErrorCode)).toBe(true);
        expect(publicSet.has(code as ErrorCode) && internalSet.has(code as ErrorCode)).toBe(false);
      });
      expect(publicSet.size + internalSet.size).toBe(Object.keys(ERROR_TAXONOMY).length);
    });
  });

  describe("Public / internal split", () => {
    it("classifies every public code as public and not internal", () => {
      PUBLIC_ERROR_CODES.forEach((code) => {
        const entry = ERROR_TAXONOMY[code] as PublicError;
        expect(isPublicError(entry)).toBe(true);
        expect(isInternalError(entry)).toBe(false);
      });
    });

    it("classifies every internal code as internal and not public", () => {
      INTERNAL_ERROR_CODES.forEach((code) => {
        const entry = ERROR_TAXONOMY[code] as InternalError;
        expect(isInternalError(entry)).toBe(true);
        expect(isPublicError(entry)).toBe(false);
      });
    });

    it("does not mix public and internal codes", () => {
      const publicSet = new Set<string>(PUBLIC_ERROR_CODES);
      const internalSet = new Set<string>(INTERNAL_ERROR_CODES);
      const overlap = PUBLIC_ERROR_CODES.filter((code) => internalSet.has(code));
      expect(overlap).toHaveLength(0);
      const covered = [...publicSet, ...internalSet].sort();
      expect(covered).toEqual(Object.keys(ERROR_TAXONOMY).sort());
    });

    it("keeps internal codes in the 5xx range and never exposes 500s publicly", () => {
      Object.values(ERROR_TAXONOMY).forEach((entry) => {
        if (entry.scope === "internal") {
          expect(entry.status).toBeGreaterThanOrEqual(500);
        } else {
          // Public codes are 4xx except the intentionally retryable 503s.
          expect(entry.status < 500 || entry.status === 503).toBe(true);
        }
      });
    });
  });

  describe("HTTP status mapping", () => {
    const statusTests: Record<string, number> = {
      BAD_REQUEST: 400,
      VALIDATION_ERROR: 422,
      MISSING_REQUIRED_FIELD: 400,
      INVALID_PAYLOAD: 400,
      MALFORMED_JSON: 400,
      UNAUTHORIZED: 401,
      AUTHENTICATION_REQUIRED: 401,
      INVALID_TOKEN: 401,
      INVALID_API_KEY: 401,
      INVALID_SIGNATURE: 401,
      INVALID_TIMESTAMP: 401,
      TIMESTAMP_OUT_OF_SKEW: 401,
      FORBIDDEN: 403,
      INSUFFICIENT_PERMISSIONS: 403,
      INVALID_ROLE: 400,
      RATE_LIMITED: 429,
      FEATURE_DISABLED: 503,
      IDEMPOTENCY_KEY_INVALID: 400,
      IDEMPOTENCY_IN_PROGRESS: 409,
      IDEMPOTENCY_KEY_MISMATCH: 422,
      REPLAY_DETECTED: 409,
      UNSUPPORTED_MEDIA_TYPE: 415,
      NOT_ACCEPTABLE: 406,
      NOT_FOUND: 404,
      CONFLICT: 409,
      UNPROCESSABLE_ENTITY: 422,
      BUNDLE_EXPIRED: 422,
      BUNDLE_NOT_TRANSFERABLE: 422,
      QUERY_BUDGET_EXCEEDED: 503,
      DB_ERROR: 500,
      INTERNAL_ERROR: 500,
      SERVICE_UNAVAILABLE: 503,
      CONFIGURATION_ERROR: 503,
      FEATURE_FLAG_EVALUATION_ERROR: 500,
    };

    Object.entries(statusTests).forEach(([code, expectedStatus]) => {
      it(`maps ${code} to HTTP ${expectedStatus}`, () => {
        expect(ERROR_TAXONOMY[code as ErrorCode].status).toBe(expectedStatus);
      });
    });
  });

  describe("i18n message resolution", () => {
    it("resolves an English message for every taxonomy key", () => {
      Object.values(ERROR_TAXONOMY).forEach((entry) => {
        const message = resolveMessage(entry.messageKey, "en");
        expect(message).not.toBe(entry.messageKey);
        expect(message.length).toBeGreaterThan(0);
      });
    });

    it("resolves a Spanish message for every taxonomy key", () => {
      Object.values(ERROR_TAXONOMY).forEach((entry) => {
        const message = resolveMessage(entry.messageKey, "es");
        expect(message).not.toBe(entry.messageKey);
        expect(message.length).toBeGreaterThan(0);
      });
    });

    it("exposes identical key sets across all locales", () => {
      const flattenKeys = (catalog: Record<string, unknown>, prefix = ""): string[] =>
        Object.entries(catalog).flatMap(([key, value]) => {
          const path = prefix ? `${prefix}.${key}` : key;
          return typeof value === "object" && value !== null
            ? flattenKeys(value as Record<string, unknown>, path)
            : [path];
        });

      const locales = getSupportedLocales();
      const catalogs = locales.map((locale) => getMessageCatalog(locale));
      const reference = flattenKeys(catalogs[0] as unknown as Record<string, unknown>).sort();
      catalogs.slice(1).forEach((catalog) => {
        expect(flattenKeys(catalog as unknown as Record<string, unknown>).sort()).toEqual(
          reference,
        );
      });
    });

    it("routes budget and bundle messages", () => {
      expect(resolveMessage(ERROR_TAXONOMY.QUERY_BUDGET_EXCEEDED.messageKey, "en")).toMatch(
        /query budget/i,
      );
      expect(resolveMessage(ERROR_TAXONOMY.BUNDLE_EXPIRED.messageKey, "en")).toMatch(/expired/i);
      expect(resolveMessage(ERROR_TAXONOMY.BUNDLE_NOT_TRANSFERABLE.messageKey, "en")).toMatch(
        /transferable/i,
      );
    });
  });

  describe("Backward compatibility", () => {
    it("exposes ERROR_CODES with the legacy {status, code} shape", () => {
      expect(ERROR_CODES).toBeDefined();
      expect(ERROR_CODES.NOT_FOUND).toEqual({ status: 404, code: "NOT_FOUND" });
      expect(ERROR_CODES.INTERNAL_ERROR).toEqual({ status: 500, code: "INTERNAL_ERROR" });
    });

    it("derives every ERROR_CODES entry from the taxonomy", () => {
      Object.keys(ERROR_TAXONOMY).forEach((code) => {
        expect(code in ERROR_CODES).toBe(true);
        const taxonomyEntry = ERROR_TAXONOMY[code as ErrorCode];
        const legacyEntry = ERROR_CODES[code as ErrorCode];
        expect(legacyEntry.status).toBe(taxonomyEntry.status);
        expect(legacyEntry.code).toBe(taxonomyEntry.code);
      });
    });
  });

  describe("Type guards", () => {
    it("rejects an internal error via isPublicError", () => {
      expect(isPublicError(ERROR_TAXONOMY.DB_ERROR)).toBe(false);
    });

    it("rejects a public error via isInternalError", () => {
      expect(isInternalError(ERROR_TAXONOMY.NOT_FOUND)).toBe(false);
    });

    it("narrows to the correct scope for a runtime-constructed value", () => {
      const record: Record<ErrorCode, ErrorType> = { ...ERROR_TAXONOMY };
      const notFound: ErrorType = record.NOT_FOUND;
      expect(isPublicError(notFound)).toBe(true);
      expect(isInternalError(notFound)).toBe(false);
    });
  });

  describe("Message key creation", () => {
    it("creates a branded key from a plain string", () => {
      const key = createMessageKey("errors.test.key");
      expect(typeof key).toBe("string");
      expect(key).toBe("errors.test.key");
    });

    it("supports supported-locale lookup via catalog", () => {
      const locales: SupportedLocale[] = ["en", "es"];
      locales.forEach((locale) => {
        const catalog = getMessageCatalog(locale);
        expect(catalog.errors.validation.bad_request).toBeDefined();
      });
    });
  });
});
