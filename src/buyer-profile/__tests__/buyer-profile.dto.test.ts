/**
 * Dedicated suite for src/buyer-profile/dto/buyer-profile.dto.ts.
 *
 * Pins the public contract of every export:
 *   - ValidationError          (shape of every returned error)
 *   - CreateBuyerProfileDTO / UpdateBuyerProfileDTO (type-level shape, runtime helpers)
 *   - validateCreateBuyerProfileDTO / validateUpdateBuyerProfileDTO / validateUUIDParam
 *   - transformCreateDTO / transformUpdateDTO
 *   - validateCreateBuyerProfile / validateUpdateBuyerProfile / validateUUID (Express middleware)
 *
 * No production code is modified; this file only adds coverage.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";
import {
  validateCreateBuyerProfileDTO,
  validateUpdateBuyerProfileDTO,
  validateUUIDParam,
  transformCreateDTO,
  transformUpdateDTO,
  validateCreateBuyerProfile,
  validateUpdateBuyerProfile,
  validateUUID,
  type ValidationError,
  type CreateBuyerProfileDTO,
  type UpdateBuyerProfileDTO,
} from "../dto/buyer-profile.dto.js";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

/** Deterministic valid fixture matching the DTO shape and every LIMITS bound. */
function validCreateDTO(): CreateBuyerProfileDTO {
  return {
    fullName: "Alice Smith",
    email: "alice@example.com",
    phoneNumber: "+1 (555) 123-4567",
    address: "123 Main St",
    avatarUrl: "https://example.com/avatar.png",
  };
}

function validUpdateDTO(): UpdateBuyerProfileDTO {
  return validCreateDTO();
}

/** Assert an error entry exists for `field`, optionally containing message text. */
function expectError(errors: ValidationError[], field: string, messageSubstr?: string) {
  const match = errors.find((e) => e.field === field);
  expect(match).toBeDefined();
  if (messageSubstr !== undefined) {
    expect(match!.message).toContain(messageSubstr);
  }
}

/** Assert NO error entry exists for `field`. */
function expectNoError(errors: ValidationError[], field: string) {
  expect(errors.find((e) => e.field === field)).toBeUndefined();
}

// ---------------------------------------------------------------------------
// ValidationError shape — the contract every validator returns
// ---------------------------------------------------------------------------

describe("ValidationError", () => {
  it("every validator returns only { field, message } string pairs", () => {
    const producers: Array<(input: unknown) => ValidationError[]> = [
      validateCreateBuyerProfileDTO,
      validateUpdateBuyerProfileDTO,
      validateUUIDParam,
    ];

    const inputs = [
      null,
      undefined,
      "string",
      42,
      {},
      validCreateDTO(),
      { fullName: "", email: "bad", phoneNumber: 1, address: [], avatarUrl: {} },
      { id: 123 },
    ];

    for (const produce of producers) {
      for (const input of inputs) {
        for (const error of produce(input)) {
          expect(Object.keys(error).sort()).toEqual(["field", "message"]);
          expect(typeof error.field).toBe("string");
          expect(typeof error.message).toBe("string");
          expect(error.field.length).toBeGreaterThan(0);
          expect(error.message.length).toBeGreaterThan(0);
        }
        // The result itself is always an array — never null/undefined/throw.
        expect(Array.isArray(produce(input))).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CreateBuyerProfileDTO / UpdateBuyerProfileDTO — type contract at runtime
// ---------------------------------------------------------------------------

describe("CreateBuyerProfileDTO & UpdateBuyerProfileDTO contract", () => {
  it("CreateBuyerProfileDTO requires fullName, email, phoneNumber and allows address, avatarUrl", () => {
    const dto = validCreateDTO();
    expect(typeof dto.fullName).toBe("string");
    expect(typeof dto.email).toBe("string");
    expect(typeof dto.phoneNumber).toBe("string");
    expect(dto.address).toBeDefined();
    expect(dto.avatarUrl).toBeDefined();

    const minimal: CreateBuyerProfileDTO = {
      fullName: "Min",
      email: "m@example.com",
      phoneNumber: "+15551112222",
    };
    expect(minimal.address).toBeUndefined();
    expect(minimal.avatarUrl).toBeUndefined();
  });

  it("UpdateBuyerProfileDTO allows every field to be optional and independently settable", () => {
    expect(Object.keys(validUpdateDTO()).sort()).toEqual(
      ["address", "avatarUrl", "email", "fullName", "phoneNumber"].sort(),
    );
    for (const key of ["fullName", "email", "phoneNumber", "address", "avatarUrl"]) {
      const partial: UpdateBuyerProfileDTO = { [key]: "value" } as UpdateBuyerProfileDTO;
      expect((partial as Record<string, unknown>)[key]).toBe("value");
    }
  });
});

// ---------------------------------------------------------------------------
// validateCreateBuyerProfileDTO
// ---------------------------------------------------------------------------

describe("validateCreateBuyerProfileDTO", () => {
  describe("primary success paths", () => {
    it("accepts a minimal valid DTO", () => {
      const { address: _a, avatarUrl: _v, ...minimal } = validCreateDTO();
      expect(validateCreateBuyerProfileDTO(minimal)).toEqual([]);
    });

    it("accepts a fully-populated valid DTO", () => {
      expect(validateCreateBuyerProfileDTO(validCreateDTO())).toEqual([]);
    });

    it("accepts unicode letters, apostrophes, hyphens and periods in fullName", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), fullName: "José O'Neil-Smith Jr." }),
      ).toEqual([]);
    });
  });

  describe("body-level failures", () => {
    it("rejects null, undefined and primitives with a single body error", () => {
      for (const bad of [null, undefined, "string", 42, true]) {
        const errors = validateCreateBuyerProfileDTO(bad);
        expect(errors).toHaveLength(1);
        expectError(errors, "body", "Request body is required");
      }
    });

    it("rejects unknown fields and names every offender", () => {
      const errors = validateCreateBuyerProfileDTO({
        ...validCreateDTO(),
        hacker: "x",
        extra: 1,
      });
      expectError(errors, "body", "Unknown field(s)");
      expect(errors[0].message).toContain("hacker");
      expect(errors[0].message).toContain("extra");
    });

    it("aggregates multiple field errors in one pass (deterministic order)", () => {
      const errors = validateCreateBuyerProfileDTO({
        fullName: "A",
        email: "bad",
        phoneNumber: "abc",
        rogue: true,
      });
      // unknown-field error first, then per-field errors
      expect(errors[0]).toMatchObject({ field: "body", message: expect.stringContaining("rogue") });
      expectError(errors, "fullName", "at least 2 characters");
      expectError(errors, "email", "Invalid email format");
      expectError(errors, "phoneNumber", "Invalid phone number format");
      expect(errors.map((e) => e.field)).toEqual(["body", "fullName", "email", "phoneNumber"]);
    });
  });

  describe("fullName boundaries", () => {
    it("rejects missing and non-string fullName", () => {
      const { fullName: _omit, ...rest } = validCreateDTO();
      expectError(validateCreateBuyerProfileDTO(rest), "fullName", "Full name is required");
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), fullName: 42 as unknown as string }),
        "fullName",
        "Full name is required",
      );
    });

    it("enforces min length 2 (reject 1, accept 2)", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), fullName: "A" }),
        "fullName",
        "at least 2 characters",
      );
      expectNoError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), fullName: "Ab" }),
        "fullName",
      );
    });

    it("length limits apply to whitespace-normalized fullName (101 rejected, 100 accepted)", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), fullName: "A".repeat(101) }),
        "fullName",
        "not exceed 100 characters",
      );
      expectNoError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), fullName: "A".repeat(100) }),
        "fullName",
      );
    });

    it("length is measured on normalized whitespace, so padded names count differently", () => {
      // 60 spaces + 42 chars = 102 raw, but normalizes to 42 — accepted.
      expectNoError(
        validateCreateBuyerProfileDTO({
          ...validCreateDTO(),
          fullName: `${" ".repeat(60)}${"A".repeat(42)}`,
        }),
        "fullName",
      );
      // 101 chars plus padding still exceeds the limit after normalization.
      expectError(
        validateCreateBuyerProfileDTO({
          ...validCreateDTO(),
          fullName: ` ${"A".repeat(100)} A`,
        }),
        "fullName",
        "not exceed 100 characters",
      );
    });

    it("rejects digits and HTML-significant characters", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), fullName: "Alice123" }),
        "fullName",
        "invalid characters",
      );
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), fullName: "Alice <script>" }),
        "fullName",
        "invalid characters",
      );
    });
  });

  describe("email boundaries", () => {
    it("rejects missing and non-string email", () => {
      const { email: _omit, ...rest } = validCreateDTO();
      expectError(validateCreateBuyerProfileDTO(rest), "email", "Email is required");
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), email: 0 as unknown as string }),
        "email",
        "Email is required",
      );
    });

    it("rejects malformed emails", () => {
      for (const bad of ["not-an-email", "@example.com", "a@b", "a b@example.com"]) {
        expectError(
          validateCreateBuyerProfileDTO({ ...validCreateDTO(), email: bad }),
          "email",
          "Invalid email format",
        );
      }
    });

    it("rejects emails padded with whitespace — validation runs on the raw value before transform", () => {
      // isValidEmail sees "  a@b.co  " and the whitespace fails the anchored regex;
      // lowercasing/trimming only happens later in transformCreateDTO.
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), email: "  padded@example.com  " }),
        "email",
        "Invalid email format",
      );
    });

    it("accepts common valid email shapes", () => {
      for (const good of ["user@example.com", "user.name+tag@example.com", "simple@example.com"]) {
        expectNoError(validateCreateBuyerProfileDTO({ ...validCreateDTO(), email: good }), "email");
      }
    });

    it("enforces max length 255 (reject 256, accept 255)", () => {
      // 243 local chars + "@example.com" (12) = exactly 255.
      const at255 = `${"a".repeat(243)}@example.com`;
      expect(at255.length).toBe(255);
      expectNoError(validateCreateBuyerProfileDTO({ ...validCreateDTO(), email: at255 }), "email");

      const at256 = `x${at255}`;
      expect(at256.length).toBe(256);
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), email: at256 }),
        "email",
        "not exceed 255 characters",
      );
    });
  });

  describe("phoneNumber boundaries", () => {
    it("rejects missing and non-string phoneNumber", () => {
      const { phoneNumber: _omit, ...rest } = validCreateDTO();
      expectError(validateCreateBuyerProfileDTO(rest), "phoneNumber", "Phone number is required");
      expectError(
        validateCreateBuyerProfileDTO({
          ...validCreateDTO(),
          phoneNumber: true as unknown as string,
        }),
        "phoneNumber",
        "Phone number is required",
      );
    });

    it("enforces min length 7 (reject 6, accept 7)", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), phoneNumber: "123456" }),
        "phoneNumber",
        "Invalid phone number format",
      );
      expectNoError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), phoneNumber: "1234567" }),
        "phoneNumber",
      );
    });

    it("enforces max length 20 (reject 21, accept 20)", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), phoneNumber: "1".repeat(21) }),
        "phoneNumber",
        "not exceed 20 characters",
      );
      expectNoError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), phoneNumber: "1".repeat(20) }),
        "phoneNumber",
      );
    });

    it("rejects letters and accepts digits, spaces, hyphens, plus and parentheses", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), phoneNumber: "123-abc-4567" }),
        "phoneNumber",
        "Invalid phone number format",
      );
      for (const good of ["+15551234567", "+1 (555) 123-4567", "555-1234", "+44 20 7946 0958"]) {
        expectNoError(
          validateCreateBuyerProfileDTO({ ...validCreateDTO(), phoneNumber: good }),
          "phoneNumber",
        );
      }
    });
  });

  describe("optional fields (address, avatarUrl)", () => {
    it("accepts undefined and null address/avatarUrl", () => {
      expect(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), address: undefined, avatarUrl: null }),
      ).toEqual([]);
    });

    it("rejects non-string address and avatarUrl", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), address: 123 as unknown as string }),
        "address",
        "Address must be a string",
      );
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), avatarUrl: {} as unknown as string }),
        "avatarUrl",
        "Avatar URL must be a string",
      );
    });

    it("enforces address max length 500 (reject 501, accept 500)", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), address: "x".repeat(501) }),
        "address",
        "not exceed 500 characters",
      );
      expectNoError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), address: "x".repeat(500) }),
        "address",
      );
    });

    it("enforces avatarUrl max length 2048 (reject 2049, accept 2048)", () => {
      const at2048 = `https://example.com/${"a".repeat(2028)}`;
      expect(at2048.length).toBe(2048);
      expectNoError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), avatarUrl: at2048 }),
        "avatarUrl",
      );

      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), avatarUrl: `${at2048}x` }),
        "avatarUrl",
        "not exceed 2048 characters",
      );
    });

    it("rejects malformed URLs and accepts valid ones", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDTO(), avatarUrl: "not a url" }),
        "avatarUrl",
        "Invalid URL format",
      );
      for (const good of [
        "https://example.com/a.png",
        "http://localhost:8080/avatar.png",
        "data:image/png;base64,aaaa",
      ]) {
        expectNoError(
          validateCreateBuyerProfileDTO({ ...validCreateDTO(), avatarUrl: good }),
          "avatarUrl",
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// validateUpdateBuyerProfileDTO
// ---------------------------------------------------------------------------

describe("validateUpdateBuyerProfileDTO", () => {
  describe("primary success paths", () => {
    it("accepts a single-field update", () => {
      expect(validateUpdateBuyerProfileDTO({ fullName: "New Name" })).toEqual([]);
    });

    it("accepts an all-fields update", () => {
      expect(validateUpdateBuyerProfileDTO(validUpdateDTO())).toEqual([]);
    });
  });

  describe("body-level failures", () => {
    it("rejects null, undefined and primitives with a single body error", () => {
      for (const bad of [null, undefined, "x", 7]) {
        const errors = validateUpdateBuyerProfileDTO(bad);
        expect(errors).toHaveLength(1);
        expectError(errors, "body", "Request body is required");
      }
    });

    it("rejects an empty object (no fields provided)", () => {
      expectError(validateUpdateBuyerProfileDTO({}), "body", "At least one field must be provided");
    });

    it("rejects unknown fields even alongside a valid field", () => {
      const errors = validateUpdateBuyerProfileDTO({ fullName: "A B", rogue: 1 });
      expectError(errors, "body", "Unknown field(s)");
      expect(errors[0].message).toContain("rogue");
    });

    it("reports both unknown-field and empty-update errors when only unknown keys are present", () => {
      const errors = validateUpdateBuyerProfileDTO({ notAField: 1 });
      expect(errors).toHaveLength(2);
      expect(
        errors.some(
          (e) => e.message.startsWith("Unknown field(s)") && e.message.includes("notAField"),
        ),
      ).toBe(true);
      expect(errors.some((e) => e.message.includes("At least one field"))).toBe(true);
      expect(errors.every((e) => e.field === "body")).toBe(true);
    });
  });

  describe("field validation mirrors create", () => {
    it("fullName: too short, too long, wrong type", () => {
      expectError(
        validateUpdateBuyerProfileDTO({ fullName: "A" }),
        "fullName",
        "at least 2 characters",
      );
      expectError(
        validateUpdateBuyerProfileDTO({ fullName: "A".repeat(101) }),
        "fullName",
        "not exceed 100 characters",
      );
      expectError(
        validateUpdateBuyerProfileDTO({ fullName: 1 as unknown as string }),
        "fullName",
        "Full name must be a string",
      );
    });

    it("email: invalid format, too long, wrong type", () => {
      expectError(validateUpdateBuyerProfileDTO({ email: "bad" }), "email", "Invalid email format");
      expectError(
        validateUpdateBuyerProfileDTO({ email: `${"a".repeat(244)}@example.com` }),
        "email",
        "not exceed 255 characters",
      );
      expectError(
        validateUpdateBuyerProfileDTO({ email: [] as unknown as string }),
        "email",
        "Email must be a string",
      );
    });

    it("phoneNumber: too short, too long, wrong characters, wrong type", () => {
      expectError(
        validateUpdateBuyerProfileDTO({ phoneNumber: "123456" }),
        "phoneNumber",
        "Invalid phone number format",
      );
      expectError(
        validateUpdateBuyerProfileDTO({ phoneNumber: "1".repeat(21) }),
        "phoneNumber",
        "not exceed 20 characters",
      );
      expectError(
        validateUpdateBuyerProfileDTO({ phoneNumber: "phone?" }),
        "phoneNumber",
        "Invalid phone number format",
      );
      expectError(
        validateUpdateBuyerProfileDTO({ phoneNumber: {} as unknown as string }),
        "phoneNumber",
        "Phone number must be a string",
      );
    });

    it("address: wrong type and too long; absent is valid", () => {
      expectError(
        validateUpdateBuyerProfileDTO({ address: 1 as unknown as string }),
        "address",
        "Address must be a string",
      );
      expectError(
        validateUpdateBuyerProfileDTO({ address: "x".repeat(501) }),
        "address",
        "not exceed 500 characters",
      );
      expectNoError(validateUpdateBuyerProfileDTO({ fullName: "A B" }), "address");
    });

    it("avatarUrl: wrong type, invalid URL, too long; absent is valid", () => {
      expectError(
        validateUpdateBuyerProfileDTO({ avatarUrl: 5 as unknown as string }),
        "avatarUrl",
        "Avatar URL must be a string",
      );
      expectError(
        validateUpdateBuyerProfileDTO({ avatarUrl: "no-scheme" }),
        "avatarUrl",
        "Invalid URL format",
      );
      expectError(
        validateUpdateBuyerProfileDTO({ avatarUrl: `https://e.co/${"a".repeat(2040)}extra!` }),
        "avatarUrl",
        "not exceed 2048 characters",
      );
      expectNoError(validateUpdateBuyerProfileDTO({ fullName: "A B" }), "avatarUrl");
    });
  });
});

// ---------------------------------------------------------------------------
// validateUUIDParam
// ---------------------------------------------------------------------------

describe("validateUUIDParam", () => {
  it("accepts a valid UUID", () => {
    expect(validateUUIDParam({ id: VALID_UUID })).toEqual([]);
  });

  it("rejects non-object params", () => {
    const errors = validateUUIDParam(null);
    expect(errors).toHaveLength(1);
    expectError(errors, "params", "Request params are required");
  });

  it("rejects missing and non-string id", () => {
    expectError(validateUUIDParam({}), "id", "Profile ID is required");
    expectError(validateUUIDParam({ id: 1 }), "id", "Profile ID is required");
  });

  it("rejects malformed UUIDs (deterministic message)", () => {
    for (const bad of [
      "not-a-uuid",
      VALID_UUID.slice(1),
      VALID_UUID.replace("-", "_"),
      `${VALID_UUID}0`,
    ]) {
      expectError(validateUUIDParam({ id: bad }), "id", "Invalid UUID format");
    }
  });
});

// ---------------------------------------------------------------------------
// transformCreateDTO / transformUpdateDTO — normalization semantics
// ---------------------------------------------------------------------------

describe("transformCreateDTO", () => {
  it("normalizes unicode whitespace, strips < >, lowercases email, trims phone and avatarUrl", () => {
    const out = transformCreateDTO({
      fullName: "\u00A0 Alice\u2003 <Smith>\t ",
      email: "  ALICE@example.com  ",
      phoneNumber: "  +1 555 123-4567  ",
      address: "  12\u00A0Analytical   <Engine>  Way  ",
      avatarUrl: "  https://example.com/a.png  ",
    });

    expect(out.fullName).toBe("Alice Smith");
    expect(out.email).toBe("alice@example.com");
    expect(out.phoneNumber).toBe("+1 555 123-4567");
    expect(out.address).toBe("12 Analytical Engine Way");
    expect(out.avatarUrl).toBe("https://example.com/a.png");
    expect(Object.keys(out).sort()).toEqual(
      ["address", "avatarUrl", "email", "fullName", "phoneNumber"].sort(),
    );
  });

  it("omits optional keys entirely when undefined (no undefined properties leak)", () => {
    const out = transformCreateDTO({
      fullName: "A B",
      email: "user@example.com",
      phoneNumber: "1234567",
    });
    expect("address" in out).toBe(false);
    expect("avatarUrl" in out).toBe(false);
  });

  it("never mutates the input object", () => {
    const input = validCreateDTO();
    const snapshot = { ...input };
    transformCreateDTO(input);
    expect(input).toEqual(snapshot);
  });
});

describe("transformUpdateDTO", () => {
  it("transforms only the fields present and preserves their normalizations", () => {
    const out = transformUpdateDTO({
      email: "  NEW@example.com  ",
      fullName: "  José  <O'Neil>  ",
      phoneNumber: " +15550001111 ",
    });
    expect(out.email).toBe("new@example.com");
    expect(out.fullName).toBe("José O'Neil");
    expect(out.phoneNumber).toBe("+15550001111");
    expect("address" in out).toBe(false);
    expect("avatarUrl" in out).toBe(false);
  });

  it("passes undefined optional fields through as undefined", () => {
    const out = transformUpdateDTO({
      address: undefined,
      avatarUrl: undefined,
      fullName: "A B",
    });
    expect(out.address).toBeUndefined();
    expect(out.avatarUrl).toBeUndefined();
    expect(out.fullName).toBe("A B");
  });

  it("maps an empty-string address to undefined (falsy address is dropped)", () => {
    const out = transformUpdateDTO({ address: "" });
    expect(out.address).toBeUndefined();
  });

  it("strips < > from present address — stripping runs after whitespace normalization", () => {
    // normalizeWhitespace collapses runs first, then < > are removed, leaving the
    // collapsed gaps in place. Characterised so a reordering is deliberate.
    const out = transformUpdateDTO({
      address: "  a < b > c  ",
      avatarUrl: "  https://e.co/x.png  ",
    });
    expect(out.address).toBe("a  b  c");
    expect(out.avatarUrl).toBe("https://e.co/x.png");
  });

  it("never mutates the input object", () => {
    const input = validUpdateDTO();
    const snapshot = { ...input };
    transformUpdateDTO(input);
    expect(input).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Express middleware — primary state transitions (reject / transform / pass)
// ---------------------------------------------------------------------------

describe("buyer-profile DTO middleware", () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    req = { body: {}, params: {} };
    jsonMock = jest.fn();
    statusMock = jest.fn(() => res as Response);
    res = {
      status: statusMock as unknown as Response["status"],
      json: jsonMock as unknown as Response["json"],
    };
    next = jest.fn();
  });

  describe("validateCreateBuyerProfile", () => {
    it("passes a valid body to next() and replaces req.body with the transformed DTO", () => {
      // Padding is applied only to fields that validate cleanly on their raw value:
      // fullName is normalized before its checks, while email must already be trim-free.
      req.body = { ...validCreateDTO(), email: "ALICE@example.com", fullName: "  Alice  Smith " };
      validateCreateBuyerProfile(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(statusMock).not.toHaveBeenCalled();
      expect(req.body).toMatchObject({
        fullName: "Alice Smith",
        email: "alice@example.com",
      });
    });

    it("responds 400 with success:false, error and details on invalid body", () => {
      req.body = { ...validCreateDTO(), email: "bad" };
      validateCreateBuyerProfile(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Validation failed",
        details: [expect.objectContaining({ field: "email", message: "Invalid email format" })],
      });
    });
  });

  describe("validateUpdateBuyerProfile", () => {
    it("passes a valid partial body to next() with normalized fields", () => {
      // Whitespace-only normalization survives validation; < > does not (see below).
      req.body = { fullName: "  Ada  Byron  " };
      validateUpdateBuyerProfile(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(statusMock).not.toHaveBeenCalled();
      expect(req.body).toEqual({ fullName: "Ada Byron" });
    });

    it("responds 400 for a body whose field is invalid on its raw value (e.g. < > in fullName)", () => {
      // Validation precedes sanitization: transformUpdateDTO would strip < >, but the
      // middleware never reaches it. Pinning this makes the ordering observable.
      req.body = { fullName: "Ada <Byron>" };
      validateUpdateBuyerProfile(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Validation failed",
        details: [
          expect.objectContaining({
            field: "fullName",
            message: "Full name contains invalid characters",
          }),
        ],
      });
    });

    it("responds 400 for an empty update body", () => {
      req.body = {};
      validateUpdateBuyerProfile(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Validation failed",
        details: [expect.objectContaining({ field: "body" })],
      });
    });
  });

  describe("validateUUID", () => {
    it("passes a valid UUID param to next() without touching the response", () => {
      req.params = { id: VALID_UUID };
      validateUUID(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(statusMock).not.toHaveBeenCalled();
      expect(jsonMock).not.toHaveBeenCalled();
    });

    it("responds 400 with an id error for a malformed UUID", () => {
      req.params = { id: "abc" };
      validateUUID(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        error: "Validation failed",
        details: [expect.objectContaining({ field: "id", message: "Invalid UUID format" })],
      });
    });
  });
});
