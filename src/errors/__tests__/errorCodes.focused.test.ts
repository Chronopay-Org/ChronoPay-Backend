import { describe, expect, it } from "@jest/globals";
import {
  ERROR_TAXONOMY,
  PUBLIC_ERROR_CODES,
  createMessageKey,
  isInternalError,
  isPublicError,
  type ErrorType,
  type I18nMessageKey,
  type PublicErrorCode,
} from "../errorCodes.js";

describe("errorCodes focused public-contract behavior", () => {
  describe("I18nMessageKey and createMessageKey", () => {
    it("brands a message key without changing its runtime value", () => {
      const raw = "errors.validation.bad_request";
      const key: I18nMessageKey = createMessageKey(raw);

      expect(key).toBe(raw);
      expect(typeof key).toBe("string");
    });

    it("requires explicit branding for plain strings at compile time", () => {
      // @ts-expect-error Plain strings are intentionally not I18nMessageKey values.
      const unbranded: I18nMessageKey = "errors.validation.bad_request";

      expect(unbranded).toBe("errors.validation.bad_request");
    });
  });

  describe("PublicErrorCode", () => {
    it("accepts representative public codes and exposes them at runtime", () => {
      const publicCodes: PublicErrorCode[] = ["BAD_REQUEST", "NOT_FOUND", "FEATURE_DISABLED"];

      publicCodes.forEach((code) => {
        expect(PUBLIC_ERROR_CODES).toContain(code);
        expect(ERROR_TAXONOMY[code].scope).toBe("public");
      });
    });

    it("excludes internal and unknown codes from the public contract", () => {
      // @ts-expect-error Internal codes must not be assignable to PublicErrorCode.
      const internalCode: PublicErrorCode = "DB_ERROR";
      // @ts-expect-error Unknown codes must not be assignable to PublicErrorCode.
      const unknownCode: PublicErrorCode = "NOT_A_CHRONOPAY_CODE";

      expect(PUBLIC_ERROR_CODES).not.toContain(internalCode);
      expect(PUBLIC_ERROR_CODES).not.toContain(unknownCode);
    });
  });

  describe("scope transitions and invalid runtime values", () => {
    it("classifies public and internal states deterministically as the value changes", () => {
      let current: ErrorType = ERROR_TAXONOMY.NOT_FOUND;
      expect(isPublicError(current)).toBe(true);
      expect(isInternalError(current)).toBe(false);

      current = ERROR_TAXONOMY.DB_ERROR;
      expect(isPublicError(current)).toBe(false);
      expect(isInternalError(current)).toBe(true);

      current = ERROR_TAXONOMY.FEATURE_DISABLED;
      expect(isPublicError(current)).toBe(true);
      expect(isInternalError(current)).toBe(false);
    });

    it("rejects a representative malformed scope value", () => {
      const malformed = {
        ...ERROR_TAXONOMY.NOT_FOUND,
        scope: "unexpected",
      } as unknown as ErrorType;

      expect(isPublicError(malformed)).toBe(false);
      expect(isInternalError(malformed)).toBe(false);
    });
  });
});
