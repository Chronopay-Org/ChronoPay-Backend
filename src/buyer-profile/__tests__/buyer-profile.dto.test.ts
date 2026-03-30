/**
 * Buyer Profile DTO Unit Tests
 * 
 * Tests all validation functions and DTO transformations.
 */

import {
  validateCreateBuyerProfileDTO,
  validateUpdateBuyerProfileDTO,
  validateUUIDParam,
  transformCreateDTO,
  transformUpdateDTO,
  CreateBuyerProfileDTO,
  UpdateBuyerProfileDTO,
} from "../dto/buyer-profile.dto.js";

describe("BuyerProfileDTO", () => {
  describe("validateCreateBuyerProfileDTO", () => {
    const validData: CreateBuyerProfileDTO = {
      fullName: "John Doe",
      email: "john.doe@example.com",
      phoneNumber: "+1234567890",
      address: "123 Main St",
      avatarUrl: "https://example.com/avatar.jpg",
    };

    it("should return no errors for valid data", () => {
      const errors = validateCreateBuyerProfileDTO(validData);

      expect(errors).toHaveLength(0);
    });

    it("should return error when data is not an object", () => {
      const errors = validateCreateBuyerProfileDTO(null);

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "body" })
      );
    });

    it("should return error when fullName is missing", () => {
      const { fullName, ...data } = validData;
      const errors = validateCreateBuyerProfileDTO(data);

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "fullName" })
      );
    });

    it("should return error when fullName is too short", () => {
      const errors = validateCreateBuyerProfileDTO({
        ...validData,
        fullName: "J",
      });

      expect(errors).toContainEqual(
        expect.objectContaining({
          field: "fullName",
          message: "Full name must be at least 2 characters",
        })
      );
    });

    it("should return error when fullName is too long", () => {
      const errors = validateCreateBuyerProfileDTO({
        ...validData,
        fullName: "A".repeat(101),
      });

      expect(errors).toContainEqual(
        expect.objectContaining({
          field: "fullName",
          message: "Full name must not exceed 100 characters",
        })
      );
    });

    it("should return error when email is missing", () => {
      const { email, ...data } = validData;
      const errors = validateCreateBuyerProfileDTO(data);

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "email" })
      );
    });

    it("should return error when email format is invalid", () => {
      const errors = validateCreateBuyerProfileDTO({
        ...validData,
        email: "invalid-email",
      });

      expect(errors).toContainEqual(
        expect.objectContaining({
          field: "email",
          message: "Invalid email format",
        })
      );
    });

    it("should return error when email is too long", () => {
      const errors = validateCreateBuyerProfileDTO({
        ...validData,
        email: "a".repeat(250) + "@example.com",
      });

      expect(errors).toContainEqual(
        expect.objectContaining({
          field: "email",
          message: "Email must not exceed 255 characters",
        })
      );
    });

    it("should return error when phoneNumber is missing", () => {
      const { phoneNumber, ...data } = validData;
      const errors = validateCreateBuyerProfileDTO(data);

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "phoneNumber" })
      );
    });

    it("should return error when phoneNumber format is invalid", () => {
      const errors = validateCreateBuyerProfileDTO({
        ...validData,
        phoneNumber: "123", // too short
      });

      expect(errors).toContainEqual(
        expect.objectContaining({
          field: "phoneNumber",
          message: "Invalid phone number format",
        })
      );
    });

    it("should accept valid phone number formats", () => {
      const formats = [
        "+1234567890",
        "123-456-7890",
        "(123) 456-7890",
        "123 456 7890",
        "+1 (123) 456-7890",
      ];

      formats.forEach((phoneNumber) => {
        const errors = validateCreateBuyerProfileDTO({
          ...validData,
          phoneNumber,
        });

        expect(errors).not.toContainEqual(
          expect.objectContaining({ field: "phoneNumber" })
        );
      });
    });

    it("should return error when address is too long", () => {
      const errors = validateCreateBuyerProfileDTO({
        ...validData,
        address: "A".repeat(501),
      });

      expect(errors).toContainEqual(
        expect.objectContaining({
          field: "address",
          message: "Address must not exceed 500 characters",
        })
      );
    });

    it("should return error when avatarUrl format is invalid", () => {
      const errors = validateCreateBuyerProfileDTO({
        ...validData,
        avatarUrl: "not-a-url",
      });

      expect(errors).toContainEqual(
        expect.objectContaining({
          field: "avatarUrl",
          message: "Invalid URL format",
        })
      );
    });

    it("should accept valid URL formats", () => {
      const urls = [
        "https://example.com/avatar.jpg",
        "http://example.com/avatar.png",
        "https://cdn.example.com/path/to/avatar.gif",
      ];

      urls.forEach((avatarUrl) => {
        const errors = validateCreateBuyerProfileDTO({
          ...validData,
          avatarUrl,
        });

        expect(errors).not.toContainEqual(
          expect.objectContaining({ field: "avatarUrl" })
        );
      });
    });

    it("should allow optional fields to be undefined", () => {
      const minimalData = {
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      };

      const errors = validateCreateBuyerProfileDTO(minimalData);

      expect(errors).toHaveLength(0);
    });

    it("should allow optional fields to be null", () => {
      const dataWithNulls = {
        ...validData,
        address: null,
        avatarUrl: null,
      };

      const errors = validateCreateBuyerProfileDTO(dataWithNulls);

      expect(errors).toHaveLength(0);
    });
  });

  describe("validateUpdateBuyerProfileDTO", () => {
    it("should return no errors for valid partial update", () => {
      const errors = validateUpdateBuyerProfileDTO({
        fullName: "John Updated",
      });

      expect(errors).toHaveLength(0);
    });

    it("should return error when data is not an object", () => {
      const errors = validateUpdateBuyerProfileDTO(null);

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "body" })
      );
    });

    it("should return error when no fields are provided", () => {
      const errors = validateUpdateBuyerProfileDTO({});

      expect(errors).toContainEqual(
        expect.objectContaining({
          field: "body",
          message: "At least one field must be provided for update",
        })
      );
    });

    it("should validate fullName if provided", () => {
      const errors = validateUpdateBuyerProfileDTO({
        fullName: "J",
      });

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "fullName" })
      );
    });

    it("should validate email if provided", () => {
      const errors = validateUpdateBuyerProfileDTO({
        email: "invalid-email",
      });

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "email" })
      );
    });

    it("should validate phoneNumber if provided", () => {
      const errors = validateUpdateBuyerProfileDTO({
        phoneNumber: "123",
      });

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "phoneNumber" })
      );
    });

    it("should validate address if provided", () => {
      const errors = validateUpdateBuyerProfileDTO({
        address: "A".repeat(501),
      });

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "address" })
      );
    });

    it("should validate avatarUrl if provided", () => {
      const errors = validateUpdateBuyerProfileDTO({
        avatarUrl: "not-a-url",
      });

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "avatarUrl" })
      );
    });

    it("should allow multiple fields to be updated", () => {
      const errors = validateUpdateBuyerProfileDTO({
        fullName: "John Updated",
        email: "john.updated@example.com",
        phoneNumber: "+9999999999",
      });

      expect(errors).toHaveLength(0);
    });
  });

  describe("validateUUIDParam", () => {
    it("should return no errors for valid UUID", () => {
      const errors = validateUUIDParam({
        id: "550e8400-e29b-41d4-a716-446655440000",
      });

      expect(errors).toHaveLength(0);
    });

    it("should return error when params is not an object", () => {
      const errors = validateUUIDParam(null);

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "params" })
      );
    });

    it("should return error when id is missing", () => {
      const errors = validateUUIDParam({});

      expect(errors).toContainEqual(
        expect.objectContaining({ field: "id" })
      );
    });

    it("should return error when id is not a valid UUID", () => {
      const errors = validateUUIDParam({
        id: "invalid-uuid",
      });

      expect(errors).toContainEqual(
        expect.objectContaining({
          field: "id",
          message: "Invalid UUID format",
        })
      );
    });

    it("should accept valid UUID formats", () => {
      const uuids = [
        "550e8400-e29b-41d4-a716-446655440000",
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
      ];

      uuids.forEach((id) => {
        const errors = validateUUIDParam({ id });
        expect(errors).toHaveLength(0);
      });
    });
  });

  describe("transformCreateDTO", () => {
    it("should trim and normalize email to lowercase", () => {
      const dto: CreateBuyerProfileDTO = {
        fullName: "  John Doe  ",
        email: "  JOHN.DOE@EXAMPLE.COM  ",
        phoneNumber: "  +1234567890  ",
      };

      const transformed = transformCreateDTO(dto);

      expect(transformed.fullName).toBe("John Doe");
      expect(transformed.email).toBe("john.doe@example.com");
      expect(transformed.phoneNumber).toBe("+1234567890");
    });

    it("should sanitize fullName by removing angle brackets", () => {
      const dto: CreateBuyerProfileDTO = {
        fullName: "John <script>alert('xss')</script> Doe",
        email: "john@example.com",
        phoneNumber: "+1234567890",
      };

      const transformed = transformCreateDTO(dto);

      expect(transformed.fullName).toBe("John scriptalert('xss')/script Doe");
    });

    it("should trim address and avatarUrl", () => {
      const dto: CreateBuyerProfileDTO = {
        fullName: "John Doe",
        email: "john@example.com",
        phoneNumber: "+1234567890",
        address: "  123 Main St  ",
        avatarUrl: "  https://example.com/avatar.jpg  ",
      };

      const transformed = transformCreateDTO(dto);

      expect(transformed.address).toBe("123 Main St");
      expect(transformed.avatarUrl).toBe("https://example.com/avatar.jpg");
    });

    it("should handle undefined optional fields", () => {
      const dto: CreateBuyerProfileDTO = {
        fullName: "John Doe",
        email: "john@example.com",
        phoneNumber: "+1234567890",
      };

      const transformed = transformCreateDTO(dto);

      expect(transformed.address).toBeUndefined();
      expect(transformed.avatarUrl).toBeUndefined();
    });
  });

  describe("transformUpdateDTO", () => {
    it("should trim and normalize email to lowercase", () => {
      const dto: UpdateBuyerProfileDTO = {
        email: "  JOHN.UPDATED@EXAMPLE.COM  ",
      };

      const transformed = transformUpdateDTO(dto);

      expect(transformed.email).toBe("john.updated@example.com");
    });

    it("should sanitize fullName by removing angle brackets", () => {
      const dto: UpdateBuyerProfileDTO = {
        fullName: "John <b>Updated</b> Doe",
      };

      const transformed = transformUpdateDTO(dto);

      expect(transformed.fullName).toBe("John bUpdated/b Doe");
    });

    it("should handle undefined fields", () => {
      const dto: UpdateBuyerProfileDTO = {
        fullName: "John Updated",
      };

      const transformed = transformUpdateDTO(dto);

      expect(transformed.fullName).toBe("John Updated");
      expect(transformed.email).toBeUndefined();
      expect(transformed.phoneNumber).toBeUndefined();
    });

    it("should handle undefined optional fields", () => {
      const dto: UpdateBuyerProfileDTO = {
        address: undefined,
        avatarUrl: undefined,
      };

      const transformed = transformUpdateDTO(dto);

      expect(transformed.address).toBeUndefined();
      expect(transformed.avatarUrl).toBeUndefined();
    });
  });
});
