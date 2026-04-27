/**
 * Buyer Profile Service Unit Tests
 * 
 * Comprehensive tests for the Buyer Profile service layer.
 * Tests all CRUD operations, edge cases, and error handling.
 */

import { buyerProfileService } from "../buyer-profile.service.js";
import { CreateBuyerProfileData, UpdateBuyerProfileData } from "../types/buyer-profile.types.js";

describe("BuyerProfileService", () => {
  // Clear all profiles before each test
  beforeEach(async () => {
    await buyerProfileService.clearAll();
  });

  describe("create", () => {
    const validProfileData: CreateBuyerProfileData = {
      userId: "user-1",
      fullName: "John Doe",
      email: "john.doe@example.com",
      phoneNumber: "+1234567890",
      address: "123 Main St, City, Country",
      avatarUrl: "https://example.com/avatar.jpg",
    };

    it("should create a buyer profile successfully", async () => {
      const profile = await buyerProfileService.create(validProfileData);

      expect(profile).toBeDefined();
      expect(profile.id).toBeDefined();
      expect(profile.userId).toBe(validProfileData.userId);
      expect(profile.fullName).toBe(validProfileData.fullName);
      expect(profile.email).toBe(validProfileData.email.toLowerCase());
      expect(profile.phoneNumber).toBe(validProfileData.phoneNumber);
      expect(profile.address).toBe(validProfileData.address);
      expect(profile.avatarUrl).toBe(validProfileData.avatarUrl);
      expect(profile.createdAt).toBeInstanceOf(Date);
      expect(profile.updatedAt).toBeInstanceOf(Date);
      expect(profile.deletedAt).toBeNull();
    });

    it("should create a profile with optional fields omitted", async () => {
      const minimalData: CreateBuyerProfileData = {
        userId: "user-2",
        fullName: "Jane Smith",
        email: "jane.smith@example.com",
        phoneNumber: "+0987654321",
      };

      const profile = await buyerProfileService.create(minimalData);

      expect(profile).toBeDefined();
      expect(profile.address).toBeUndefined();
      expect(profile.avatarUrl).toBeUndefined();
    });

    it("should normalize email to lowercase", async () => {
      const dataWithUpperCaseEmail: CreateBuyerProfileData = {
        ...validProfileData,
        email: "JOHN.DOE@EXAMPLE.COM",
      };

      const profile = await buyerProfileService.create(dataWithUpperCaseEmail);

      expect(profile.email).toBe("john.doe@example.com");
    });

    it("should throw error when user already has a profile", async () => {
      await buyerProfileService.create(validProfileData);

      await expect(buyerProfileService.create(validProfileData)).rejects.toThrow(
        "User already has a buyer profile"
      );
    });

    it("should throw error when email is already in use", async () => {
      await buyerProfileService.create(validProfileData);

      const duplicateEmailData: CreateBuyerProfileData = {
        userId: "user-2",
        fullName: "Another User",
        email: validProfileData.email,
        phoneNumber: "+1111111111",
      };

      await expect(buyerProfileService.create(duplicateEmailData)).rejects.toThrow(
        "Email is already in use"
      );
    });

    it("should throw error when email is already in use (case insensitive)", async () => {
      await buyerProfileService.create(validProfileData);

      const duplicateEmailData: CreateBuyerProfileData = {
        userId: "user-2",
        fullName: "Another User",
        email: validProfileData.email.toUpperCase(),
        phoneNumber: "+1111111111",
      };

      await expect(buyerProfileService.create(duplicateEmailData)).rejects.toThrow(
        "Email is already in use"
      );
    });
  });

  describe("getById", () => {
    it("should return profile when found", async () => {
      const created = await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      });

      const profile = await buyerProfileService.getById(created.id);

      expect(profile).toBeDefined();
      expect(profile?.id).toBe(created.id);
    });

    it("should return null when profile not found", async () => {
      const profile = await buyerProfileService.getById("non-existent-id");

      expect(profile).toBeNull();
    });

    it("should return null for deleted profile", async () => {
      const created = await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      });

      await buyerProfileService.delete(created.id);

      const profile = await buyerProfileService.getById(created.id);

      expect(profile).toBeNull();
    });
  });

  describe("getByUserId", () => {
    it("should return profile when found by userId", async () => {
      const created = await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      });

      const profile = await buyerProfileService.getByUserId("user-1");

      expect(profile).toBeDefined();
      expect(profile?.id).toBe(created.id);
    });

    it("should return null when userId not found", async () => {
      const profile = await buyerProfileService.getByUserId("non-existent-user");

      expect(profile).toBeNull();
    });
  });

  describe("getByEmail", () => {
    it("should return profile when found by email", async () => {
      const created = await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      });

      const profile = await buyerProfileService.getByEmail("john.doe@example.com");

      expect(profile).toBeDefined();
      expect(profile?.id).toBe(created.id);
    });

    it("should find profile by email (case insensitive)", async () => {
      await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      });

      const profile = await buyerProfileService.getByEmail("JOHN.DOE@EXAMPLE.COM");

      expect(profile).toBeDefined();
    });

    it("should return null when email not found", async () => {
      const profile = await buyerProfileService.getByEmail("nonexistent@example.com");

      expect(profile).toBeNull();
    });
  });

  describe("list", () => {
    beforeEach(async () => {
      // Create multiple profiles for testing
      await buyerProfileService.create({
        userId: "user-1",
        fullName: "Alice Johnson",
        email: "alice@example.com",
        phoneNumber: "+1111111111",
      });

      await buyerProfileService.create({
        userId: "user-2",
        fullName: "Bob Smith",
        email: "bob@example.com",
        phoneNumber: "+2222222222",
      });

      await buyerProfileService.create({
        userId: "user-3",
        fullName: "Charlie Brown",
        email: "charlie@example.com",
        phoneNumber: "+3333333333",
      });
    });

    it("should return all profiles with default pagination", async () => {
      const result = await buyerProfileService.list();

      expect(result.data).toHaveLength(3);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.total).toBe(3);
      expect(result.pagination.totalPages).toBe(1);
    });

    it("should filter by userId", async () => {
      const result = await buyerProfileService.list({ userId: "user-1" });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].userId).toBe("user-1");
    });

    it("should filter by email", async () => {
      const result = await buyerProfileService.list({ email: "bob@example.com" });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].email).toBe("bob@example.com");
    });

    it("should filter by fullName (partial match)", async () => {
      const result = await buyerProfileService.list({ fullName: "Alice" });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].fullName).toContain("Alice");
    });

    it("should paginate results", async () => {
      const page1 = await buyerProfileService.list({}, { page: 1, limit: 2 });

      expect(page1.data).toHaveLength(2);
      expect(page1.pagination.page).toBe(1);
      expect(page1.pagination.limit).toBe(2);
      expect(page1.pagination.total).toBe(3);
      expect(page1.pagination.totalPages).toBe(2);

      const page2 = await buyerProfileService.list({}, { page: 2, limit: 2 });

      expect(page2.data).toHaveLength(1);
      expect(page2.pagination.page).toBe(2);
    });

    it("should return empty array when no profiles match filters", async () => {
      const result = await buyerProfileService.list({ userId: "non-existent" });

      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
    });

    it("should sort by createdAt descending", async () => {
      const result = await buyerProfileService.list();

      expect(result.data[0].createdAt.getTime()).toBeGreaterThanOrEqual(
        result.data[1].createdAt.getTime()
      );
      expect(result.data[1].createdAt.getTime()).toBeGreaterThanOrEqual(
        result.data[2].createdAt.getTime()
      );
    });
  });

  describe("update", () => {
    let profileId: string;

    beforeEach(async () => {
      const profile = await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
        address: "123 Main St",
      });
      profileId = profile.id;
    });

    it("should update profile successfully", async () => {
      const updateData: UpdateBuyerProfileData = {
        fullName: "John Updated",
        phoneNumber: "+9999999999",
      };

      const updated = await buyerProfileService.update(profileId, updateData);

      expect(updated.fullName).toBe("John Updated");
      expect(updated.phoneNumber).toBe("+9999999999");
      expect(updated.email).toBe("john.doe@example.com"); // unchanged
      expect(updated.updatedAt).toBeInstanceOf(Date);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updated.createdAt.getTime());
    });

    it("should update email successfully", async () => {
      const updateData: UpdateBuyerProfileData = {
        email: "john.new@example.com",
      };

      const updated = await buyerProfileService.update(profileId, updateData);

      expect(updated.email).toBe("john.new@example.com");
    });

    it("should normalize email to lowercase on update", async () => {
      const updateData: UpdateBuyerProfileData = {
        email: "JOHN.NEW@EXAMPLE.COM",
      };

      const updated = await buyerProfileService.update(profileId, updateData);

      expect(updated.email).toBe("john.new@example.com");
    });

    it("should allow partial updates", async () => {
      const updateData: UpdateBuyerProfileData = {
        address: "456 New St",
      };

      const updated = await buyerProfileService.update(profileId, updateData);

      expect(updated.address).toBe("456 New St");
      expect(updated.fullName).toBe("John Doe"); // unchanged
      expect(updated.email).toBe("john.doe@example.com"); // unchanged
    });

    it("should throw error when profile not found", async () => {
      await expect(
        buyerProfileService.update("non-existent-id", { fullName: "Test" })
      ).rejects.toThrow("Profile not found");
    });

    it("should throw error when email is already in use by another profile", async () => {
      await buyerProfileService.create({
        userId: "user-2",
        fullName: "Jane Smith",
        email: "jane.smith@example.com",
        phoneNumber: "+0987654321",
      });

      await expect(
        buyerProfileService.update(profileId, { email: "jane.smith@example.com" })
      ).rejects.toThrow("Email is already in use by another profile");
    });

    it("should allow updating to same email", async () => {
      const updateData: UpdateBuyerProfileData = {
        email: "john.doe@example.com",
      };

      const updated = await buyerProfileService.update(profileId, updateData);

      expect(updated.email).toBe("john.doe@example.com");
    });

    it("should clear optional fields when set to undefined", async () => {
      const updateData: UpdateBuyerProfileData = {
        address: undefined,
        avatarUrl: undefined,
      };

      const updated = await buyerProfileService.update(profileId, updateData);

      expect(updated.address).toBeUndefined();
      expect(updated.avatarUrl).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("should soft delete profile successfully", async () => {
      const profile = await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      });

      await buyerProfileService.delete(profile.id);

      // Profile should not be found after deletion
      const deletedProfile = await buyerProfileService.getById(profile.id);
      expect(deletedProfile).toBeNull();

      // User should not have a profile anymore
      const hasProfile = await buyerProfileService.userHasProfile("user-1");
      expect(hasProfile).toBe(false);
    });

    it("should throw error when profile not found", async () => {
      await expect(buyerProfileService.delete("non-existent-id")).rejects.toThrow(
        "Profile not found"
      );
    });

    it("should allow creating new profile after deletion", async () => {
      const profile = await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      });

      await buyerProfileService.delete(profile.id);

      // Should be able to create a new profile for the same user
      const newProfile = await buyerProfileService.create({
        userId: "user-1",
        fullName: "John New",
        email: "john.new@example.com",
        phoneNumber: "+9999999999",
      });

      expect(newProfile).toBeDefined();
      expect(newProfile.id).not.toBe(profile.id);
    });
  });

  describe("userHasProfile", () => {
    it("should return true when user has a profile", async () => {
      await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      });

      const hasProfile = await buyerProfileService.userHasProfile("user-1");

      expect(hasProfile).toBe(true);
    });

    it("should return false when user does not have a profile", async () => {
      const hasProfile = await buyerProfileService.userHasProfile("user-1");

      expect(hasProfile).toBe(false);
    });

    it("should return false after profile is deleted", async () => {
      const profile = await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      });

      await buyerProfileService.delete(profile.id);

      const hasProfile = await buyerProfileService.userHasProfile("user-1");

      expect(hasProfile).toBe(false);
    });
  });

  describe("count", () => {
    it("should return correct count of profiles", async () => {
      expect(await buyerProfileService.count()).toBe(0);

      await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      });

      expect(await buyerProfileService.count()).toBe(1);

      await buyerProfileService.create({
        userId: "user-2",
        fullName: "Jane Smith",
        email: "jane.smith@example.com",
        phoneNumber: "+0987654321",
      });

      expect(await buyerProfileService.count()).toBe(2);
    });

    it("should not count deleted profiles", async () => {
      const profile = await buyerProfileService.create({
        userId: "user-1",
        fullName: "John Doe",
        email: "john.doe@example.com",
        phoneNumber: "+1234567890",
      });

      expect(await buyerProfileService.count()).toBe(1);

      await buyerProfileService.delete(profile.id);

      expect(await buyerProfileService.count()).toBe(0);
    });
  });
});
