import { describe, it, expect, beforeEach } from "@jest/globals";
import type {
  BuyerProfile,
  CreateBuyerProfileData,
  UpdateBuyerProfileData,
  BuyerProfileFilters,
  PaginationParams,
  PaginatedResponse,
  ApiResponse,
} from "../types/buyer-profile.types.js";
import {
  validateCreateBuyerProfileDTO,
  validateUpdateBuyerProfileDTO,
  validateUUIDParam,
  transformCreateDTO,
  transformUpdateDTO,
  type ValidationError,
  type CreateBuyerProfileDTO,
  type UpdateBuyerProfileDTO,
} from "../dto/buyer-profile.dto.js";
import { BuyerProfileService, buyerProfileService } from "../buyer-profile.service.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID_2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function expectError(errors: ValidationError[], field: string, messageSubstr?: string) {
  const match = errors.find((e) => e.field === field);
  expect(match).toBeDefined();
  if (messageSubstr !== undefined) {
    expect(match!.message).toContain(messageSubstr);
  }
}

function validCreateDto(): CreateBuyerProfileDTO {
  return {
    fullName: "Alice Smith",
    email: "alice@example.com",
    phoneNumber: "+1 (555) 123-4567",
    address: "123 Main St",
    avatarUrl: "https://example.com/avatar.png",
  };
}

function validCreateData(userId: string = VALID_UUID): CreateBuyerProfileData {
  return {
    userId,
    ...validCreateDto(),
  };
}

function assertBuyerProfileShape(p: BuyerProfile) {
  expect(typeof p.id).toBe("string");
  expect(p.id.length).toBeGreaterThan(0);
  expect(typeof p.userId).toBe("string");
  expect(typeof p.fullName).toBe("string");
  expect(typeof p.email).toBe("string");
  expect(typeof p.phoneNumber).toBe("string");
  expect(p.createdAt).toBeInstanceOf(Date);
  expect(p.updatedAt).toBeInstanceOf(Date);
  expect(p.createdAt.getTime()).toBeLessThanOrEqual(p.updatedAt.getTime());
}

describe("BuyerProfile types — contract & fixtures", () => {
  describe("BuyerProfile interface shape (via runtime service output)", () => {
    const service = new BuyerProfileService();

    beforeEach(async () => {
      await service.clearAll();
    });

    it("produce a BuyerProfile with all required fields populated on create", async () => {
      const created = await service.create(validCreateData());
      assertBuyerProfileShape(created);
      expect(created.email).toBe("alice@example.com");
      expect(created.fullName).toBe("Alice Smith");
      expect(created.address).toBe("123 Main St");
      expect(created.avatarUrl).toBe("https://example.com/avatar.png");
      expect(created.deletedAt).toBeNull();
    });

    it("BuyerProfile supports optional fields absent", async () => {
      const created = await service.create({
        userId: VALID_UUID,
        fullName: "Bob Jones",
        email: "bob@example.com",
        phoneNumber: "+15559876543",
      });
      assertBuyerProfileShape(created);
      expect(created.address).toBeUndefined();
      expect(created.avatarUrl).toBeUndefined();
    });
  });

  describe("CreateBuyerProfileData — contract", () => {
    it("requires userId, fullName, email, phoneNumber; address and avatarUrl are optional", () => {
      const data: CreateBuyerProfileData = {
        userId: VALID_UUID,
        fullName: "Minimal",
        email: "min@example.com",
        phoneNumber: "+15551112222",
      };
      expect(data.userId).toBe(VALID_UUID);
      expect(data.address).toBeUndefined();
      expect(data.avatarUrl).toBeUndefined();

      const withOptional: CreateBuyerProfileData = {
        userId: VALID_UUID,
        fullName: "Full User",
        email: "full@example.com",
        phoneNumber: "+15551112222",
        address: "addr",
        avatarUrl: "https://x/y.png",
      };
      expect(withOptional.address).toBe("addr");
      expect(withOptional.avatarUrl).toBe("https://x/y.png");
    });
  });

  describe("UpdateBuyerProfileData — contract", () => {
    it("allows partial updates: any combination of fields is valid", () => {
      const onlyName: UpdateBuyerProfileData = { fullName: "New Name" };
      expect(onlyName.fullName).toBe("New Name");
      expect(onlyName.email).toBeUndefined();

      const onlyEmail: UpdateBuyerProfileData = { email: "new@example.com" };
      expect(onlyEmail.email).toBe("new@example.com");

      const allFields: UpdateBuyerProfileData = {
        fullName: "A",
        email: "a@b.co",
        phoneNumber: "+15550000000",
        address: "addr",
        avatarUrl: "https://a/b.png",
      };
      expect(Object.keys(allFields).sort()).toEqual(
        ["address", "avatarUrl", "email", "fullName", "phoneNumber"].sort()
      );
    });
  });
});

describe("validateCreateBuyerProfileDTO", () => {
  it("returns no errors for a minimal valid DTO", () => {
    const dto: CreateBuyerProfileDTO = {
      fullName: "Alice Smith",
      email: "alice@example.com",
      phoneNumber: "+15551234567",
    };
    expect(validateCreateBuyerProfileDTO(dto)).toEqual([]);
  });

  it("returns no errors for a DTO with all optional fields", () => {
    expect(validateCreateBuyerProfileDTO(validCreateDto())).toEqual([]);
  });

  it("rejects null or non-object body", () => {
    expectError(validateCreateBuyerProfileDTO(null), "body", "required");
    expectError(validateCreateBuyerProfileDTO(undefined), "body", "required");
    expectError(validateCreateBuyerProfileDTO("string"), "body", "required");
    expectError(validateCreateBuyerProfileDTO(123), "body", "required");
  });

  it("rejects unknown fields", () => {
    const errors = validateCreateBuyerProfileDTO({ ...validCreateDto(), hacker: "x", other: "y" });
    expectError(errors, "body", "Unknown field(s)");
    expect(errors[0].message).toContain("hacker");
    expect(errors[0].message).toContain("other");
  });

  describe("fullName validation", () => {
    it("rejects missing fullName", () => {
      const { fullName: _omit, ...rest } = validCreateDto();
      expectError(validateCreateBuyerProfileDTO(rest), "fullName", "required");
    });

    it("rejects non-string fullName", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), fullName: 42 as unknown as string }),
        "fullName",
        "required"
      );
    });

    it("rejects fullName shorter than 2 characters", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), fullName: "A" }),
        "fullName",
        "at least 2 characters"
      );
    });

    it("accepts fullName of exactly 2 characters", () => {
      const errors = validateCreateBuyerProfileDTO({ ...validCreateDto(), fullName: "Ab" });
      expect(errors.find((e) => e.field === "fullName")).toBeUndefined();
    });

    it("rejects fullName longer than 100 characters", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), fullName: "A".repeat(101) }),
        "fullName",
        "not exceed 100 characters"
      );
    });

    it("accepts fullName of exactly 100 characters", () => {
      const errors = validateCreateBuyerProfileDTO({ ...validCreateDto(), fullName: "A".repeat(100) });
      expect(errors.find((e) => e.field === "fullName")).toBeUndefined();
    });

    it("rejects fullName containing digits or special characters", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), fullName: "Alice123" }),
        "fullName",
        "invalid characters"
      );
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), fullName: "Alice <script>" }),
        "fullName",
        "invalid characters"
      );
    });

    it("accepts unicode letters, apostrophes, hyphens, and periods in fullName", () => {
      expect(
        validateCreateBuyerProfileDTO({
          ...validCreateDto(),
          fullName: "José O'Neil-Smith Jr.",
        })
      ).toEqual([]);
    });
  });

  describe("email validation", () => {
    it("rejects missing email", () => {
      const { email: _omit, ...rest } = validCreateDto();
      expectError(validateCreateBuyerProfileDTO(rest), "email", "required");
    });

    it("rejects non-string email", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), email: 0 as unknown as string }),
        "email",
        "required"
      );
    });

    it("rejects invalid email format", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), email: "not-an-email" }),
        "email",
        "Invalid email format"
      );
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), email: "@example.com" }),
        "email",
        "Invalid email format"
      );
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), email: "a@b" }),
        "email",
        "Invalid email format"
      );
    });

    it("accepts valid email formats", () => {
      const valid = [
        "user@example.com",
        "user.name+tag@example.co.uk",
        "a@b.cd",
      ];
      for (const email of valid) {
        const errors = validateCreateBuyerProfileDTO({ ...validCreateDto(), email });
        expect(errors.find((e) => e.field === "email")).toBeUndefined();
      }
    });

    it("rejects email longer than 255 characters", () => {
      const longEmail = "a".repeat(253) + "@x.co";
      expect(longEmail.length).toBeGreaterThan(255);
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), email: longEmail }),
        "email",
        "not exceed 255 characters"
      );
    });
  });

  describe("phoneNumber validation", () => {
    it("rejects missing phoneNumber", () => {
      const { phoneNumber: _omit, ...rest } = validCreateDto();
      expectError(validateCreateBuyerProfileDTO(rest), "phoneNumber", "required");
    });

    it("rejects non-string phoneNumber", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), phoneNumber: true as unknown as string }),
        "phoneNumber",
        "required"
      );
    });

    it("rejects phoneNumber shorter than 7 characters", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), phoneNumber: "123456" }),
        "phoneNumber",
        "Invalid phone number format"
      );
    });

    it("rejects phoneNumber longer than 20 characters", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), phoneNumber: "1".repeat(21) }),
        "phoneNumber",
        "not exceed 20 characters"
      );
    });

    it("rejects phoneNumber with invalid characters", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), phoneNumber: "123-abc-4567" }),
        "phoneNumber",
        "Invalid phone number format"
      );
    });

    it("accepts valid phone formats with digits, spaces, hyphens, plus, parentheses", () => {
      const validNumbers = [
        "+15551234567",
        "+1 (555) 123-4567",
        "555-1234",
        "1234567",
        "+44 20 7946 0958",
      ];
      for (const phone of validNumbers) {
        const errors = validateCreateBuyerProfileDTO({ ...validCreateDto(), phoneNumber: phone });
        expect(errors.find((e) => e.field === "phoneNumber")).toBeUndefined();
      }
    });
  });

  describe("address validation", () => {
    it("rejects non-string address", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), address: 123 as unknown as string }),
        "address",
        "must be a string"
      );
    });

    it("rejects address longer than 500 characters", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), address: "x".repeat(501) }),
        "address",
        "not exceed 500 characters"
      );
    });

    it("accepts address of exactly 500 characters", () => {
      const errors = validateCreateBuyerProfileDTO({ ...validCreateDto(), address: "x".repeat(500) });
      expect(errors.find((e) => e.field === "address")).toBeUndefined();
    });

    it("accepts address as undefined", () => {
      const { address: _omit, ...rest } = validCreateDto();
      const errors = validateCreateBuyerProfileDTO(rest);
      expect(errors.find((e) => e.field === "address")).toBeUndefined();
    });
  });

  describe("avatarUrl validation", () => {
    it("rejects non-string avatarUrl", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), avatarUrl: {} as unknown as string }),
        "avatarUrl",
        "must be a string"
      );
    });

    it("rejects avatarUrl longer than 2048 characters", () => {
      const longUrl = "https://example.com/" + "a".repeat(2040);
      expect(longUrl.length).toBeGreaterThan(2048);
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), avatarUrl: longUrl }),
        "avatarUrl",
        "not exceed 2048 characters"
      );
    });

    it("rejects invalid URL format", () => {
      expectError(
        validateCreateBuyerProfileDTO({ ...validCreateDto(), avatarUrl: "not a url" }),
        "avatarUrl",
        "Invalid URL format"
      );
    });

    it("accepts valid URLs", () => {
      const urls = ["https://example.com/a.png", "http://localhost:8080/avatar.png", "data:image/png;base64,aaaa"];
      for (const url of urls) {
        const errors = validateCreateBuyerProfileDTO({ ...validCreateDto(), avatarUrl: url });
        expect(errors.find((e) => e.field === "avatarUrl")).toBeUndefined();
      }
    });
  });
});

describe("validateUpdateBuyerProfileDTO", () => {
  it("accepts a single field update", () => {
    expect(validateUpdateBuyerProfileDTO({ fullName: "New Name" })).toEqual([]);
  });

  it("accepts all fields update", () => {
    expect(
      validateUpdateBuyerProfileDTO({
        fullName: "A B",
        email: "x@y.com",
        phoneNumber: "+15551234567",
        address: "addr",
        avatarUrl: "https://x/y.png",
      })
    ).toEqual([]);
  });

  it("rejects null or non-object body", () => {
    expectError(validateUpdateBuyerProfileDTO(null), "body", "required");
    expectError(validateUpdateBuyerProfileDTO("x"), "body", "required");
  });

  it("rejects empty object (no known fields)", () => {
    expectError(validateUpdateBuyerProfileDTO({}), "body", "At least one field");
  });

  it("rejects unknown fields", () => {
    const errors = validateUpdateBuyerProfileDTO({ fullName: "A", badField: "x" });
    expectError(errors, "body", "Unknown field(s)");
    expect(errors[0].message).toContain("badField");
  });

  it("rejects when only unknown fields are present", () => {
    const errors = validateUpdateBuyerProfileDTO({ notAField: 1 });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expectError(errors, "body", "Unknown field(s)");
    expectError(errors, "body", "At least one field");
  });

  it("applies the same field validation as create for fullName", () => {
    expectError(validateUpdateBuyerProfileDTO({ fullName: "A" }), "fullName", "at least 2");
    expectError(validateUpdateBuyerProfileDTO({ fullName: 1 as unknown as string }), "fullName", "must be a string");
  });

  it("applies the same field validation as create for email", () => {
    expectError(validateUpdateBuyerProfileDTO({ email: "bad" }), "email", "Invalid email format");
  });

  it("applies the same field validation as create for phoneNumber", () => {
    expectError(validateUpdateBuyerProfileDTO({ phoneNumber: "short" }), "phoneNumber", "Invalid phone");
  });

  it("applies the same field validation as create for address and avatarUrl", () => {
    expectError(validateUpdateBuyerProfileDTO({ address: 1 as unknown as string }), "address", "must be a string");
    expectError(validateUpdateBuyerProfileDTO({ avatarUrl: "no-scheme" }), "avatarUrl", "Invalid URL format");
  });
});

describe("validateUUIDParam", () => {
  it("accepts valid UUID", () => {
    expect(validateUUIDParam({ id: VALID_UUID })).toEqual([]);
  });

  it("rejects non-object params", () => {
    expectError(validateUUIDParam(null), "params", "required");
  });

  it("rejects missing id", () => {
    expectError(validateUUIDParam({}), "id", "required");
  });

  it("rejects non-string id", () => {
    expectError(validateUUIDParam({ id: 1 }), "id", "required");
  });

  it("rejects malformed UUID", () => {
    expectError(validateUUIDParam({ id: "not-a-uuid" }), "id", "Invalid UUID format");
  });
});

describe("transformCreateDTO & transformUpdateDTO — normalization", () => {
  it("transformCreateDTO: normalizes whitespace and strips < > in fullName and address, lowercases email, trims phone", () => {
    const raw: CreateBuyerProfileDTO = {
      fullName: "  Alice   <Smith>  ",
      email: "  ALICE@Example.COM  ",
      phoneNumber: "  +1 555 123-4567  ",
      address: "  123  <Main>  St  ",
      avatarUrl: "  https://example.com/a.png  ",
    };
    const transformed = transformCreateDTO(raw);
    expect(transformed.fullName).toBe("Alice Smith");
    expect(transformed.email).toBe("alice@example.com");
    expect(transformed.phoneNumber).toBe("+1 555 123-4567");
    expect(transformed.address).toBe("123 Main St");
    expect(transformed.avatarUrl).toBe("https://example.com/a.png");
  });

  it("transformCreateDTO: omits undefined optional fields", () => {
    const minimal: CreateBuyerProfileDTO = {
      fullName: "A B",
      email: "a@b.co",
      phoneNumber: "1234567",
    };
    const out = transformCreateDTO(minimal);
    expect("address" in out).toBe(false);
    expect("avatarUrl" in out).toBe(false);
  });

  it("transformUpdateDTO: transforms only present fields", () => {
    const dto: UpdateBuyerProfileDTO = {
      email: "  NEW@Example.COM  ",
      fullName: "  José  <O'Neil>  ",
    };
    const out = transformUpdateDTO(dto);
    expect(out.email).toBe("new@example.com");
    expect(out.fullName).toBe("José O'Neil");
    expect("phoneNumber" in out).toBe(false);
    expect("address" in out).toBe(false);
  });

  it("transformUpdateDTO: passes undefined optional fields through as undefined", () => {
    const dto: UpdateBuyerProfileDTO = {
      address: undefined,
      avatarUrl: undefined,
      fullName: "A B",
    };
    const out = transformUpdateDTO(dto);
    expect(out.address).toBeUndefined();
    expect(out.avatarUrl).toBeUndefined();
    expect(out.fullName).toBe("A B");
  });
});

describe("State transitions — BuyerProfileService lifecycle", () => {
  const service = new BuyerProfileService();

  beforeEach(async () => {
    await service.clearAll();
  });

  it("create → getById → update → list → delete — full lifecycle", async () => {
    // 1. Create
    const created = await service.create(validCreateData());
    assertBuyerProfileShape(created);
    expect(await service.count()).toBe(1);
    expect(await service.userHasProfile(created.userId)).toBe(true);

    // 2. getById returns the same profile
    const fetched = await service.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);

    // 3. getByUserId and getByEmail return the profile
    expect((await service.getByUserId(created.userId))!.id).toBe(created.id);
    expect((await service.getByEmail(created.email))!.id).toBe(created.id);

    // 4. Update some fields
    const beforeUpdatedAt = created.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const updateData: UpdateBuyerProfileData = {
      fullName: "Alice Updated",
      email: "alice.updated@example.com",
      address: "456 New Ave",
    };
    const updated = await service.update(created.id, updateData);
    assertBuyerProfileShape(updated);
    expect(updated.fullName).toBe("Alice Updated");
    expect(updated.email).toBe("alice.updated@example.com");
    expect(updated.address).toBe("456 New Ave");
    expect(updated.phoneNumber).toBe(created.phoneNumber);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(beforeUpdatedAt.getTime());

    // Email index is updated
    expect(await service.getByEmail("alice.updated@example.com")).not.toBeNull();
    expect(await service.getByEmail(created.email)).toBeNull();

    // 5. List returns the updated profile
    const listResult = await service.list();
    expect(listResult.data.length).toBe(1);
    expect(listResult.data[0].id).toBe(created.id);
    expect(listResult.pagination.total).toBe(1);
    expect(listResult.pagination.totalPages).toBe(1);

    // 6. Soft delete
    await service.delete(created.id);
    expect(await service.count()).toBe(0);
    expect(await service.getById(created.id)).toBeNull();
    expect(await service.getByUserId(created.userId)).toBeNull();
    expect(await service.getByEmail(updated.email)).toBeNull();

    // Deleted profile still exists internally (check via hard delete)
    await service.hardDelete(created.id);
  });

  it("create throws for duplicate userId", async () => {
    await service.create(validCreateData(VALID_UUID));
    await expect(service.create(validCreateData(VALID_UUID))).rejects.toThrow(
      "User already has a buyer profile"
    );
    expect(await service.count()).toBe(1);
  });

  it("create throws for duplicate email (case insensitive)", async () => {
    await service.create(validCreateData(VALID_UUID));
    await expect(
      service.create({
        userId: VALID_UUID_2,
        fullName: "Bob",
        email: "ALICE@example.com",
        phoneNumber: "+15559998888",
      })
    ).rejects.toThrow("Email is already in use");
    expect(await service.count()).toBe(1);
  });

  it("update throws for non-existent profile", async () => {
    await expect(service.update(VALID_UUID, { fullName: "X" })).rejects.toThrow("Profile not found");
  });

  it("update throws when changing email to one already in use", async () => {
    const alice = await service.create(validCreateData(VALID_UUID));
    await service.create({
      userId: VALID_UUID_2,
      fullName: "Bob Brown",
      email: "bob@example.com",
      phoneNumber: "+15559876543",
    });
    await expect(service.update(alice.id, { email: "bob@example.com" })).rejects.toThrow(
      "Email is already in use by another profile"
    );
  });

  it("update allows setting email to the same value (case difference normalizes)", async () => {
    const profile = await service.create(validCreateData(VALID_UUID));
    const updated = await service.update(profile.id, { email: "ALICE@Example.COM" });
    expect(updated.email).toBe("alice@example.com");
  });

  it("delete throws for non-existent profile", async () => {
    await expect(service.delete(VALID_UUID)).rejects.toThrow("Profile not found");
  });

  it("getById and list hide soft-deleted profiles", async () => {
    const profile = await service.create(validCreateData());
    await service.delete(profile.id);

    expect(await service.getById(profile.id)).toBeNull();
    const listResult = await service.list();
    expect(listResult.data.length).toBe(0);
    expect(listResult.pagination.total).toBe(0);
  });

  it("list supports filters: userId, email, fullName", async () => {
    const p1 = await service.create(validCreateData(VALID_UUID));
    const p2 = await service.create({
      userId: VALID_UUID_2,
      fullName: "Bob Smith",
      email: "bob@example.com",
      phoneNumber: "+15559876543",
    });

    const byUserId = await service.list({ userId: p1.userId });
    expect(byUserId.data.map((p) => p.id)).toEqual([p1.id]);

    const byEmail = await service.list({ email: "BOB@example.com" });
    expect(byEmail.data.map((p) => p.id)).toEqual([p2.id]);

    const byName = await service.list({ fullName: "smith" });
    const ids = byName.data.map((p) => p.id).sort();
    expect(ids).toEqual([p1.id, p2.id].sort());
  });

  it("list supports pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await service.create({
        userId: `user-${i}`,
        fullName: `User ${i}`,
        email: `user${i}@example.com`,
        phoneNumber: `+1555${String(1000000 + i).padStart(7, "0")}`,
      });
    }

    const page1 = await service.list({}, { page: 1, limit: 2 });
    expect(page1.data.length).toBe(2);
    expect(page1.pagination.total).toBe(5);
    expect(page1.pagination.totalPages).toBe(3);
    expect(page1.pagination.page).toBe(1);

    const page2 = await service.list({}, { page: 2, limit: 2 });
    expect(page2.data.length).toBe(2);
    expect(page2.pagination.page).toBe(2);

    const page3 = await service.list({}, { page: 3, limit: 2 });
    expect(page3.data.length).toBe(1);
  });

  it("list pagination has sane defaults and bounds", async () => {
    for (let i = 0; i < 3; i++) {
      await service.create({
        userId: `u${i}`,
        fullName: `N${i}`,
        email: `e${i}@x.co`,
        phoneNumber: `+1${String(5550000000 + i)}`,
      });
    }

    // Default page/limit
    const defaultResult = await service.list();
    expect(defaultResult.pagination.page).toBe(1);
    expect(defaultResult.pagination.limit).toBe(10);

    // page < 1 clamps to 1, limit < 1 clamps to 1, limit > 100 clamps to 100
    const clamped = await service.list({}, { page: -5, limit: 9999 });
    expect(clamped.pagination.page).toBe(1);
    expect(clamped.pagination.limit).toBe(100);
  });

  it("hardDelete removes the profile entirely and clearAll wipes the store", async () => {
    const p1 = await service.create(validCreateData(VALID_UUID));
    const p2 = await service.create(validCreateData(VALID_UUID_2));
    expect(await service.count()).toBe(2);

    await service.hardDelete(p1.id);
    expect(await service.count()).toBe(1);
    expect(await service.getById(p1.id)).toBeNull();

    await service.clearAll();
    expect(await service.count()).toBe(0);
    expect(await service.getById(p2.id)).toBeNull();
    expect(await service.userHasProfile(p2.userId)).toBe(false);
  });
});

describe("PaginatedResponse<T> and ApiResponse<T> contract (type-level via runtime values)", () => {
  it("PaginatedResponse enforces shape with data array and pagination metadata", () => {
    const page: PaginatedResponse<BuyerProfile> = {
      data: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
    };
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.pagination.page).toBeGreaterThan(0);
    expect(typeof page.pagination.total).toBe("number");
    expect(typeof page.pagination.totalPages).toBe("number");
  });

  it("ApiResponse supports success with data and failure with error", () => {
    const ok: ApiResponse<{ id: string }> = {
      success: true,
      data: { id: VALID_UUID },
      message: "Created",
    };
    expect(ok.success).toBe(true);
    expect(ok.data!.id).toBe(VALID_UUID);

    const err: ApiResponse = {
      success: false,
      error: "NOT_FOUND",
      message: "Missing",
    };
    expect(err.success).toBe(false);
    expect(err.error).toBe("NOT_FOUND");
    expect(err.data).toBeUndefined();
  });
});
