/**
 * Tests for i18n message loader.
 *
 * Validates:
 * - Message resolution for supported locales
 * - Fallback behavior for missing messages
 * - Locale support and coverage
 * - Message catalog consistency
 */

import { describe, it, expect } from "@jest/globals";
import {
  resolveMessage,
  getMessageCatalog,
  getSupportedLocales,
  type SupportedLocale,
} from "../../i18n/messageLoader.js";
import { EN_MESSAGES } from "../../i18n/locales.en.js";
import { ES_MESSAGES } from "../../i18n/locales.es.js";

describe("i18n Message Loader", () => {
  describe("Locale Support", () => {
    it("should support English locale", () => {
      const locales = getSupportedLocales();
      expect(locales).toContain("en");
    });

    it("should support Spanish locale", () => {
      const locales = getSupportedLocales();
      expect(locales).toContain("es");
    });

    it("should have at least 2 supported locales", () => {
      const locales = getSupportedLocales();
      expect(locales.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Message Catalog Loading", () => {
    it("should load English message catalog", () => {
      const catalog = getMessageCatalog("en");
      expect(catalog).toBeDefined();
      expect(catalog.errors).toBeDefined();
    });

    it("should load Spanish message catalog", () => {
      const catalog = getMessageCatalog("es");
      expect(catalog).toBeDefined();
      expect(catalog.errors).toBeDefined();
    });

    it("should throw for unsupported locale", () => {
      expect(() => {
        getMessageCatalog("unsupported" as SupportedLocale);
      }).toThrow(/Unsupported locale/);
    });
  });

  describe("Message Resolution - English", () => {
    it("should resolve validation error messages", () => {
      const bad = resolveMessage("errors.validation.bad_request" as any, "en");
      expect(bad).not.toBe("errors.validation.bad_request");
      expect(typeof bad).toBe("string");
      expect(bad.length).toBeGreaterThan(0);
    });

    it("should resolve authentication error messages", () => {
      const unauth = resolveMessage("errors.auth.unauthorized" as any, "en");
      expect(unauth).not.toBe("errors.auth.unauthorized");
      expect(typeof unauth).toBe("string");
    });

    it("should resolve authorization error messages", () => {
      const forbidden = resolveMessage(
        "errors.authz.forbidden" as any,
        "en",
      );
      expect(forbidden).not.toBe("errors.authz.forbidden");
      expect(typeof forbidden).toBe("string");
    });

    it("should resolve resource error messages", () => {
      const notFound = resolveMessage("errors.resource.not_found" as any, "en");
      expect(notFound).not.toBe("errors.resource.not_found");
      expect(typeof notFound).toBe("string");
    });

    it("should resolve internal error messages", () => {
      const dbError = resolveMessage("errors.internal.db_error" as any, "en");
      expect(dbError).not.toBe("errors.internal.db_error");
      expect(typeof dbError).toBe("string");
    });
  });

  describe("Message Resolution - Spanish", () => {
    it("should resolve validation error messages in Spanish", () => {
      const bad = resolveMessage("errors.validation.bad_request" as any, "es");
      expect(bad).not.toBe("errors.validation.bad_request");
      expect(typeof bad).toBe("string");
      expect(bad.length).toBeGreaterThan(0);
    });

    it("should resolve authentication error messages in Spanish", () => {
      const unauth = resolveMessage("errors.auth.unauthorized" as any, "es");
      expect(unauth).not.toBe("errors.auth.unauthorized");
      expect(typeof unauth).toBe("string");
    });

    it("should resolve authorization error messages in Spanish", () => {
      const forbidden = resolveMessage(
        "errors.authz.forbidden" as any,
        "es",
      );
      expect(forbidden).not.toBe("errors.authz.forbidden");
      expect(typeof forbidden).toBe("string");
    });

    it("should resolve resource error messages in Spanish", () => {
      const notFound = resolveMessage("errors.resource.not_found" as any, "es");
      expect(notFound).not.toBe("errors.resource.not_found");
      expect(typeof notFound).toBe("string");
    });

    it("should resolve internal error messages in Spanish", () => {
      const dbError = resolveMessage("errors.internal.db_error" as any, "es");
      expect(dbError).not.toBe("errors.internal.db_error");
      expect(typeof dbError).toBe("string");
    });
  });

  describe("Fallback Behavior", () => {
    it("should fallback to English for unsupported locale", () => {
      const msg = resolveMessage("errors.validation.bad_request" as any, "unsupported" as any);
      expect(typeof msg).toBe("string");
    });

    it("should return key if message not found", () => {
      const msg = resolveMessage("nonexistent.key" as any, "en");
      expect(msg).toBe("nonexistent.key");
    });

    it("should return key for nested missing paths", () => {
      const msg = resolveMessage("errors.missing.deeply.nested" as any, "en");
      expect(msg).toBe("errors.missing.deeply.nested");
    });

    it("should default to English locale if not specified", () => {
      const msg = resolveMessage("errors.validation.bad_request" as any);
      const msgEn = resolveMessage("errors.validation.bad_request" as any, "en");
      expect(msg).toBe(msgEn);
    });
  });

  describe("Message Consistency Across Locales", () => {
    it("should have same keys in all locales", () => {
      const enCatalog = getMessageCatalog("en");
      const esCatalog = getMessageCatalog("es");

      const getKeys = (obj: any, prefix = ""): string[] => {
        let keys: string[] = [];
        for (const key in obj) {
          const fullKey = prefix ? `${prefix}.${key}` : key;
          if (typeof obj[key] === "object" && obj[key] !== null) {
            keys = keys.concat(getKeys(obj[key], fullKey));
          } else {
            keys.push(fullKey);
          }
        }
        return keys;
      };

      const enKeys = getKeys(enCatalog).sort();
      const esKeys = getKeys(esCatalog).sort();

      expect(enKeys).toEqual(esKeys);
    });

    it("should have no empty message strings", () => {
      const locales: SupportedLocale[] = ["en", "es"];

      locales.forEach((locale) => {
        const catalog = getMessageCatalog(locale);

        const checkEmpty = (obj: any, path = "") => {
          for (const key in obj) {
            const fullPath = path ? `${path}.${key}` : key;
            if (typeof obj[key] === "string") {
              expect(obj[key]).not.toBe("");
              expect(obj[key].trim().length).toBeGreaterThan(0);
            } else if (typeof obj[key] === "object" && obj[key] !== null) {
              checkEmpty(obj[key], fullPath);
            }
          }
        };

        checkEmpty(catalog);
      });
    });
  });

  describe("Message Coverage", () => {
    const messageKeys = [
      "errors.validation.bad_request",
      "errors.validation.validation_error",
      "errors.validation.missing_required_field",
      "errors.validation.invalid_payload",
      "errors.validation.malformed_json",
      "errors.auth.unauthorized",
      "errors.auth.authentication_required",
      "errors.auth.invalid_token",
      "errors.auth.invalid_api_key",
      "errors.auth.invalid_signature",
      "errors.auth.invalid_timestamp",
      "errors.auth.timestamp_out_of_skew",
      "errors.authz.forbidden",
      "errors.authz.insufficient_permissions",
      "errors.authz.invalid_role",
      "errors.ratelimit.rate_limited",
      "errors.feature.feature_disabled",
      "errors.idempotency.key_invalid",
      "errors.idempotency.in_progress",
      "errors.idempotency.key_mismatch",
      "errors.idempotency.replay_detected",
      "errors.content.unsupported_media_type",
      "errors.content.not_acceptable",
      "errors.resource.not_found",
      "errors.resource.conflict",
      "errors.resource.unprocessable_entity",
      "errors.internal.db_error",
      "errors.internal.internal_error",
      "errors.internal.service_unavailable",
      "errors.internal.configuration_error",
      "errors.internal.feature_flag_evaluation_error",
    ];

    messageKeys.forEach((key) => {
      it(`should have message for ${key} in English`, () => {
        const msg = resolveMessage(key as any, "en");
        expect(msg).not.toBe(key);
        expect(typeof msg).toBe("string");
        expect(msg.length).toBeGreaterThan(0);
      });

      it(`should have message for ${key} in Spanish`, () => {
        const msg = resolveMessage(key as any, "es");
        expect(msg).not.toBe(key);
        expect(typeof msg).toBe("string");
        expect(msg.length).toBeGreaterThan(0);
      });
    });
  });

  describe("Message Catalog Structure", () => {
    it("should have errors root key", () => {
      const catalog = getMessageCatalog("en");
      expect("errors" in catalog).toBe(true);
    });

    it("should have all error categories", () => {
      const catalog = getMessageCatalog("en");
      expect("validation" in catalog.errors).toBe(true);
      expect("auth" in catalog.errors).toBe(true);
      expect("authz" in catalog.errors).toBe(true);
      expect("resource" in catalog.errors).toBe(true);
      expect("internal" in catalog.errors).toBe(true);
    });

    it("should not have extra unexpected keys", () => {
      const catalog = getMessageCatalog("en");
      const expectedTopLevel = ["errors"];
      const actualTopLevel = Object.keys(catalog);

      actualTopLevel.forEach((key) => {
        expect(expectedTopLevel).toContain(key);
      });
    });
  });

  describe("Message Localization Quality", () => {
    it("should have professional English messages", () => {
      const catalog = getMessageCatalog("en");
      expect(catalog.errors.validation.bad_request).toBeTruthy();
      expect(catalog.errors.auth.unauthorized).toBeTruthy();
    });

    it("should have professional Spanish messages", () => {
      const catalog = getMessageCatalog("es");
      expect(catalog.errors.validation.bad_request).toBeTruthy();
      expect(catalog.errors.auth.unauthorized).toBeTruthy();
      // Spanish accents should be present
      expect(catalog.errors.validation.validation_error).toMatch(/[áéíóú]/);
    });
  });
});
