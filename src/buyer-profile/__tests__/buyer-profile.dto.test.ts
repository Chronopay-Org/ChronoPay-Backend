/**
 * Buyer Profile DTO Unit Tests
 *
 * Covers: allowlist enforcement, unicode whitespace normalization,
 * phone length limits, fullName character set, avatarUrl length limit,
 * and all existing validation/transform paths.
 */

import {
  validateCreateBuyerProfileDTO,
  validateUpdateBuyerProfileDTO,
  validateUUIDParam,
  transformCreateDTO,
  transformUpdateDTO,
  validateCreateBuyerProfile,
  validateUpdateBuyerProfile,
  validateUUID,
  CreateBuyerProfileDTO,
  UpdateBuyerProfileDTO,
} from "../dto/buyer-profile.dto.js";
import { jest } from "@jest/globals";

describe("BuyerProfileDTO", () => {
  // ---------------------------------------------------------------------------
  // validateCreateBuyerProfileDTO
  // ---------------------------------------------------------------------------
  describe("validateCreateBuyerProfileDTO", () => {
    const valid: CreateBuyerProfileDTO = {
      fullName: "John Doe",
      email: "john.doe@example.com",
      phoneNumber: "+1234567890",
      address: "123 Main St",
      avatarUrl: "https://example.com/avatar.jpg",
    };

    it("returns no errors for valid data", () => {
      expect(validateCreateBuyerProfileDTO(valid)).toHaveLength(0);
    });

    it("returns error when body is not an object", () => {
      expect(validateCreateBuyerProfileDTO(null)).toContainEqual(
        expect.objectContaining({ field: "body" })
      );
    });

    // --- Allowlist ---
    it("rejects unknown fields", () => {
      const errors = validateCreateBuyerProfileDTO({ ...valid, injected: "evil" });
      expect(errors).toContainEqual(
        expect.objectContaining({ field: "body", message: expect.stringContaining("injected") })
      );
    });

    it("rejects multiple unknown fields", () => {
      const errors = validateCreateBuyerProfileDTO({ ...valid, foo: 1, bar: 2 });
      expect(errors).toContainEqual(
        expect.objectContaining({ field: "body", message: expect.stringContaining("foo") })
      );
    });

    // --- fullName ---
    it("returns error when fullName is missing", () => {
      const { fullName, ...data } = valid;
      expect(validateCreateBuyerProfileDTO(data)).toContainEqual(
        expect.objectContaining({ field: "fullName" })
      );
    });

    it("returns error when fullName is too short", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...valid, fullName: "J" })
      ).toContainEqual(
        expect.objectContaining({ field: "fullName", message: "Full name must be at least 2 characters" })
      );
    });

    it("returns error when fullName is too long", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...valid, fullName: "A".repeat(101) })
      ).toContainEqual(
        expect.objectContaining({ field: "fullName", message: "Full name must not exceed 100 characters" })
      );
    });

    it("returns error when fullName contains digits", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...valid, fullName: "John123" })
      ).toContainEqual(
        expect.objectContaining({ field: "fullName", message: "Full name contains invalid characters" })
      );
    });

    it("returns error when fullName contains special characters", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...valid, fullName: "John@Doe" })
      ).toContainEqual(
        expect.objectContaining({ field: "fullName", message: "Full name contains invalid characters" })
      );
    });

    it("accepts fullName with hyphens, apostrophes, and periods", () => {
      const names = ["Mary-Jane", "O'Brien", "Dr. Smith", "José García"];
      names.forEach((fullName) => {
        expect(validateCreateBuyerProfileDTO({ ...valid, fullName })).toHaveLength(0);
      });
    });

    it("accepts fullName with unicode letters (non-ASCII scripts)", () => {
      // Arabic, Chinese, Cyrillic
      const names = ["محمد علي", "张伟", "Иван Петров"];
      names.forEach((fullName) => {
        expect(validateCreateBuyerProfileDTO({ ...valid, fullName })).toHaveLength(0);
      });
    });

    it("normalizes unicode whitespace in fullName before length check", () => {
      // \u2003 is EM SPACE (unicode whitespace, not ASCII space)
      const errors = validateCreateBuyerProfileDTO({ ...valid, fullName: "Jo\u2003hn" });
      expect(errors).toHaveLength(0);
    });

    // --- email ---
    it("returns error when email is missing", () => {
      const { email, ...data } = valid;
      expect(validateCreateBuyerProfileDTO(data)).toContainEqual(
        expect.objectContaining({ field: "email" })
      );
    });

    it("returns error for invalid email format", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...valid, email: "invalid-email" })
      ).toContainEqual(
        expect.objectContaining({ field: "email", message: "Invalid email format" })
      );
    });

    it("returns error when email exceeds 255 characters", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...valid, email: "a".repeat(250) + "@x.com" })
      ).toContainEqual(
        expect.objectContaining({ field: "email", message: "Email must not exceed 255 characters" })
      );
    });

    // --- phoneNumber ---
    it("returns error when phoneNumber is missing", () => {
      const { phoneNumber, ...data } = valid;
      expect(validateCreateBuyerProfileDTO(data)).toContainEqual(
        expect.objectContaining({ field: "phoneNumber" })
      );
    });

    it("returns error when phoneNumber is too short (< 7 chars)", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...valid, phoneNumber: "12345" })
      ).toContainEqual(
        expect.objectContaining({ field: "phoneNumber", message: "Invalid phone number format" })
      );
    });

    it("returns error when phoneNumber exceeds 20 characters", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...valid, phoneNumber: "1".repeat(21) })
      ).toContainEqual(
        expect.objectContaining({ field: "phoneNumber", message: "Phone number must not exceed 20 characters" })
      );
    });

    it("returns error when phoneNumber contains invalid characters", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...valid, phoneNumber: "+1234abc7890" })
      ).toContainEqual(
        expect.objectContaining({ field: "phoneNumber", message: "Invalid phone number format" })
      );
    });

    it("accepts valid phone number formats", () => {
      const phones = ["+1234567890", "123-456-7890", "(123) 456-7890", "123 456 7890"];
      phones.forEach((phoneNumber) => {
        expect(validateCreateBuyerProfileDTO({ ...valid, phoneNumber })).toHaveLength(0);
      });
    });

    // --- address ---
    it("returns error when address exceeds 500 characters", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...valid, address: "A".repeat(501) })
      ).toContainEqual(
        expect.objectContaining({ field: "address", message: "Address must not exceed 500 characters" })
      );
    });

    it("allows address to be undefined or null", () => {
      expect(validateCreateBuyerProfileDTO({ ...valid, address: undefined })).toHaveLength(0);
      expect(validateCreateBuyerProfileDTO({ ...valid, address: null as unknown as string })).toHaveLength(0);
    });

    // --- avatarUrl ---
    it("returns error for invalid avatarUrl format", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...valid, avatarUrl: "not-a-url" })
      ).toContainEqual(
        expect.objectContaining({ field: "avatarUrl", message: "Invalid URL format" })
      );
    });

    it("returns error when avatarUrl exceeds 2048 characters", () => {
      const longUrl = "https://example.com/" + "a".repeat(2040);
      expect(
        validateCreateBuyerProfileDTO({ ...valid, avatarUrl: longUrl })
      ).toContainEqual(
        expect.objectContaining({ field: "avatarUrl", message: "Avatar URL must not exceed 2048 characters" })
      );
    });

    it("accepts valid avatarUrl formats", () => {
      const urls = [
        "https://example.com/avatar.jpg",
        "http://example.com/avatar.png",
        "https://cdn.example.com/path/to/avatar.gif",
      ];
      urls.forEach((avatarUrl) => {
        expect(validateCreateBuyerProfileDTO({ ...valid, avatarUrl })).toHaveLength(0);
      });
    });

    it("allows optional fields to be omitted", () => {
      expect(
        validateCreateBuyerProfileDTO({ fullName: "John Doe", email: "john@example.com", phoneNumber: "+1234567890" })
      ).toHaveLength(0);
    });

    it("returns error when address is a non-string type", () => {
      expect(
        validateCreateBuyerProfileDTO({ fullName: "John Doe", email: "john@example.com", phoneNumber: "+1234567890", address: 123 as unknown as string })
      ).toContainEqual(
        expect.objectContaining({ field: "address", message: "Address must be a string" })
      );
    });

    it("returns error when avatarUrl is a non-string type", () => {
      expect(
        validateCreateBuyerProfileDTO({ fullName: "John Doe", email: "john@example.com", phoneNumber: "+1234567890", avatarUrl: 123 as unknown as string })
      ).toContainEqual(
        expect.objectContaining({ field: "avatarUrl", message: "Avatar URL must be a string" })
      );
    });

    it("returns error when fullName is a non-string type", () => {
      expect(
        validateCreateBuyerProfileDTO({ fullName: 42 as unknown as string, email: "john@example.com", phoneNumber: "+1234567890" })
      ).toContainEqual(
        expect.objectContaining({ field: "fullName", message: "Full name is required" })
      );
    });

    it("returns error when email is a non-string type", () => {
      expect(
        validateCreateBuyerProfileDTO({ fullName: "John Doe", email: 42 as unknown as string, phoneNumber: "+1234567890" })
      ).toContainEqual(
        expect.objectContaining({ field: "email", message: "Email is required" })
      );
    });

    it("returns error when phoneNumber is a non-string type", () => {
      expect(
        validateCreateBuyerProfileDTO({ fullName: "John Doe", email: "john@example.com", phoneNumber: 1234567890 as unknown as string })
      ).toContainEqual(
        expect.objectContaining({ field: "phoneNumber", message: "Phone number is required" })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // validateUpdateBuyerProfileDTO
  // ---------------------------------------------------------------------------
  describe("validateUpdateBuyerProfileDTO", () => {
    it("returns no errors for valid partial update", () => {
      expect(validateUpdateBuyerProfileDTO({ fullName: "John Updated" })).toHaveLength(0);
    });

    it("returns error when body is not an object", () => {
      expect(validateUpdateBuyerProfileDTO(null)).toContainEqual(
        expect.objectContaining({ field: "body" })
      );
    });

    it("returns error when no fields are provided", () => {
      expect(validateUpdateBuyerProfileDTO({})).toContainEqual(
        expect.objectContaining({ field: "body", message: "At least one field must be provided for update" })
      );
    });

    // --- Allowlist ---
    it("rejects unknown fields", () => {
      const errors = validateUpdateBuyerProfileDTO({ fullName: "Jane", role: "admin" });
      expect(errors).toContainEqual(
        expect.objectContaining({ field: "body", message: expect.stringContaining("role") })
      );
    });

    it("rejects unknown fields even when known fields are present", () => {
      const errors = validateUpdateBuyerProfileDTO({ fullName: "Jane", hack: "x" });
      expect(errors).toContainEqual(
        expect.objectContaining({ field: "body", message: expect.stringContaining("hack") })
      );
    });

    // --- fullName ---
    it("validates fullName character set on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ fullName: "Jane123" })
      ).toContainEqual(
        expect.objectContaining({ field: "fullName", message: "Full name contains invalid characters" })
      );
    });

    it("validates fullName length on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ fullName: "J" })
      ).toContainEqual(
        expect.objectContaining({ field: "fullName" })
      );
    });

    // --- phoneNumber ---
    it("returns error when phoneNumber is too short on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ phoneNumber: "12345" })
      ).toContainEqual(
        expect.objectContaining({ field: "phoneNumber", message: "Invalid phone number format" })
      );
    });

    it("returns error when phoneNumber exceeds 20 chars on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ phoneNumber: "1".repeat(21) })
      ).toContainEqual(
        expect.objectContaining({ field: "phoneNumber", message: "Phone number must not exceed 20 characters" })
      );
    });

    // --- avatarUrl ---
    it("returns error when avatarUrl exceeds 2048 chars on update", () => {
      const longUrl = "https://example.com/" + "a".repeat(2040);
      expect(
        validateUpdateBuyerProfileDTO({ avatarUrl: longUrl })
      ).toContainEqual(
        expect.objectContaining({ field: "avatarUrl", message: "Avatar URL must not exceed 2048 characters" })
      );
    });

    it("validates email if provided", () => {
      expect(
        validateUpdateBuyerProfileDTO({ email: "invalid-email" })
      ).toContainEqual(
        expect.objectContaining({ field: "email" })
      );
    });

    it("validates address if provided", () => {
      expect(
        validateUpdateBuyerProfileDTO({ address: "A".repeat(501) })
      ).toContainEqual(
        expect.objectContaining({ field: "address" })
      );
    });

    it("allows multiple fields to be updated", () => {
      expect(
        validateUpdateBuyerProfileDTO({
          fullName: "John Updated",
          email: "john.updated@example.com",
          phoneNumber: "+9999999999",
        })
      ).toHaveLength(0);
    });

    it("returns error when address is a non-string type on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ address: 123 as unknown as string })
      ).toContainEqual(
        expect.objectContaining({ field: "address", message: "Address must be a string" })
      );
    });

    it("returns error when avatarUrl is a non-string type on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ avatarUrl: 123 as unknown as string })
      ).toContainEqual(
        expect.objectContaining({ field: "avatarUrl", message: "Avatar URL must be a string" })
      );
    });

    it("returns error when fullName is a non-string type on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ fullName: 42 as unknown as string })
      ).toContainEqual(
        expect.objectContaining({ field: "fullName", message: "Full name must be a string" })
      );
    });

    it("returns error when email is a non-string type on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ email: 42 as unknown as string })
      ).toContainEqual(
        expect.objectContaining({ field: "email", message: "Email must be a string" })
      );
    });

    it("returns error when phoneNumber is a non-string type on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ phoneNumber: 1234567890 as unknown as string })
      ).toContainEqual(
        expect.objectContaining({ field: "phoneNumber", message: "Phone number must be a string" })
      );
    });

    it("returns error when email exceeds 255 chars on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ email: "a".repeat(250) + "@x.com" })
      ).toContainEqual(
        expect.objectContaining({ field: "email", message: "Email must not exceed 255 characters" })
      );
    });

    it("returns error when phoneNumber contains invalid chars on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ phoneNumber: "+1234abc7890" })
      ).toContainEqual(
        expect.objectContaining({ field: "phoneNumber", message: "Invalid phone number format" })
      );
    });

    it("returns error for invalid avatarUrl format on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ avatarUrl: "not-a-url" })
      ).toContainEqual(
        expect.objectContaining({ field: "avatarUrl", message: "Invalid URL format" })
      );
    });

    it("allows address to be null on update", () => {
      expect(
        validateUpdateBuyerProfileDTO({ address: null as unknown as string })
      ).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // validateUUIDParam
  // ---------------------------------------------------------------------------
  describe("validateUUIDParam", () => {
    it("returns no errors for valid UUID", () => {
      expect(validateUUIDParam({ id: "550e8400-e29b-41d4-a716-446655440000" })).toHaveLength(0);
    });

    it("returns error when params is not an object", () => {
      expect(validateUUIDParam(null)).toContainEqual(
        expect.objectContaining({ field: "params" })
      );
    });

    it("returns error when id is missing", () => {
      expect(validateUUIDParam({})).toContainEqual(
        expect.objectContaining({ field: "id" })
      );
    });

    it("returns error for invalid UUID", () => {
      expect(validateUUIDParam({ id: "invalid-uuid" })).toContainEqual(
        expect.objectContaining({ field: "id", message: "Invalid UUID format" })
      );
    });

    it("accepts multiple valid UUID formats", () => {
      const uuids = [
        "550e8400-e29b-41d4-a716-446655440000",
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      ];
      uuids.forEach((id) => {
        expect(validateUUIDParam({ id })).toHaveLength(0);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // transformCreateDTO
  // ---------------------------------------------------------------------------
  describe("transformCreateDTO", () => {
    it("trims and lowercases email", () => {
      const result = transformCreateDTO({
        fullName: "John Doe",
        email: "  JOHN@EXAMPLE.COM  ",
        phoneNumber: "+1234567890",
      });
      expect(result.email).toBe("john@example.com");
    });

    it("normalizes unicode whitespace in fullName", () => {
      // \u2003 EM SPACE, \u00a0 NO-BREAK SPACE
      const result = transformCreateDTO({
        fullName: "John\u2003 \u00a0Doe",
        email: "john@example.com",
        phoneNumber: "+1234567890",
      });
      expect(result.fullName).toBe("John Doe");
    });

    it("strips angle brackets from fullName", () => {
      const result = transformCreateDTO({
        fullName: "John <b>Doe</b>",
        email: "john@example.com",
        phoneNumber: "+1234567890",
      });
      expect(result.fullName).toBe("John bDoe/b");
    });

    it("trims phoneNumber", () => {
      const result = transformCreateDTO({
        fullName: "John Doe",
        email: "john@example.com",
        phoneNumber: "  +1234567890  ",
      });
      expect(result.phoneNumber).toBe("+1234567890");
    });

    it("sanitizes address", () => {
      const result = transformCreateDTO({
        fullName: "John Doe",
        email: "john@example.com",
        phoneNumber: "+1234567890",
        address: "  123 Main St  ",
      });
      expect(result.address).toBe("123 Main St");
    });

    it("trims avatarUrl", () => {
      const result = transformCreateDTO({
        fullName: "John Doe",
        email: "john@example.com",
        phoneNumber: "+1234567890",
        avatarUrl: "  https://example.com/avatar.jpg  ",
      });
      expect(result.avatarUrl).toBe("https://example.com/avatar.jpg");
    });

    it("omits address and avatarUrl when not provided", () => {
      const result = transformCreateDTO({
        fullName: "John Doe",
        email: "john@example.com",
        phoneNumber: "+1234567890",
      });
      expect(result.address).toBeUndefined();
      expect(result.avatarUrl).toBeUndefined();
    });

    it("produces only allowlisted keys", () => {
      const input = {
        fullName: "John Doe",
        email: "john@example.com",
        phoneNumber: "+1234567890",
      } as CreateBuyerProfileDTO;
      const result = transformCreateDTO(input);
      const keys = Object.keys(result);
      const allowed = new Set(["fullName", "email", "phoneNumber", "address", "avatarUrl"]);
      keys.forEach((k) => expect(allowed.has(k)).toBe(true));
    });
  });

  // ---------------------------------------------------------------------------
  // transformUpdateDTO
  // ---------------------------------------------------------------------------
  describe("transformUpdateDTO", () => {
    it("trims and lowercases email", () => {
      const result = transformUpdateDTO({ email: "  JOHN.UPDATED@EXAMPLE.COM  " });
      expect(result.email).toBe("john.updated@example.com");
    });

    it("normalizes unicode whitespace in fullName", () => {
      const result = transformUpdateDTO({ fullName: "Jane\u2003Doe" });
      expect(result.fullName).toBe("Jane Doe");
    });

    it("strips angle brackets from fullName", () => {
      const result = transformUpdateDTO({ fullName: "John <b>Updated</b> Doe" });
      expect(result.fullName).toBe("John bUpdated/b Doe");
    });

    it("omits undefined fields from output", () => {
      const result = transformUpdateDTO({ fullName: "John Updated" });
      expect(result.fullName).toBe("John Updated");
      expect(result.email).toBeUndefined();
      expect(result.phoneNumber).toBeUndefined();
      expect(result.address).toBeUndefined();
      expect(result.avatarUrl).toBeUndefined();
    });

    it("produces only allowlisted keys", () => {
      const result = transformUpdateDTO({ fullName: "Jane", email: "jane@example.com" });
      const keys = Object.keys(result);
      const allowed = new Set(["fullName", "email", "phoneNumber", "address", "avatarUrl"]);
      keys.forEach((k) => expect(allowed.has(k)).toBe(true));
    });
  });

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------
  describe("middleware", () => {
    const makeRes = () => {
      const res: Record<string, jest.Mock> = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res as unknown as import("express").Response;
    };

    describe("validateCreateBuyerProfile", () => {
      it("calls next() for valid body", () => {
        const req = {
          body: { fullName: "John Doe", email: "john@example.com", phoneNumber: "+1234567890" },
        } as import("express").Request;
        const res = makeRes();
        const next = jest.fn();
        validateCreateBuyerProfile(req, res, next);
        expect(next).toHaveBeenCalled();
      });

      it("returns 400 for invalid body", () => {
        const req = { body: {} } as import("express").Request;
        const res = makeRes();
        const next = jest.fn();
        validateCreateBuyerProfile(req, res, next);
        expect((res as unknown as Record<string, jest.Mock>).status).toHaveBeenCalledWith(400);
        expect(next).not.toHaveBeenCalled();
      });
    });

    describe("validateUpdateBuyerProfile", () => {
      it("calls next() for valid body", () => {
        const req = { body: { fullName: "Jane Doe" } } as import("express").Request;
        const res = makeRes();
        const next = jest.fn();
        validateUpdateBuyerProfile(req, res, next);
        expect(next).toHaveBeenCalled();
      });

      it("returns 400 for invalid body", () => {
        const req = { body: {} } as import("express").Request;
        const res = makeRes();
        const next = jest.fn();
        validateUpdateBuyerProfile(req, res, next);
        expect((res as unknown as Record<string, jest.Mock>).status).toHaveBeenCalledWith(400);
        expect(next).not.toHaveBeenCalled();
      });
    });

    describe("validateUUID", () => {
      it("calls next() for valid UUID param", () => {
        const req = { params: { id: "550e8400-e29b-41d4-a716-446655440000" } } as unknown as import("express").Request;
        const res = makeRes();
        const next = jest.fn();
        validateUUID(req, res, next);
        expect(next).toHaveBeenCalled();
      });

      it("returns 400 for invalid UUID param", () => {
        const req = { params: { id: "bad-id" } } as unknown as import("express").Request;
        const res = makeRes();
        const next = jest.fn();
        validateUUID(req, res, next);
        expect((res as unknown as Record<string, jest.Mock>).status).toHaveBeenCalledWith(400);
        expect(next).not.toHaveBeenCalled();
      });
    });
  });
});
